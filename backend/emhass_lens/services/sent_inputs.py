"""The Inputs page's "What EMHASS gets": one MPC payload slot by slot, from the last run's artifacts or built now,
with the house load EMHASS forecast for it and what was measured before the anchor."""

import logging
from datetime import datetime, timedelta
from functools import partial
from typing import TYPE_CHECKING, Any

from pydantic import ValidationError

from emhass_lens.api.schemas import (
    BeyondSlot,
    ExplainSlot,
    HorizonOption,
    MeasuredSlot,
    Reading,
    SentDeferrable,
    SentInputs,
    SentModel,
)
from emhass_lens.core.clock import iso, parse_iso
from emhass_lens.core.slots import SLOT, slot_floor
from emhass_lens.domain.mpc.anchor import anchor_slot
from emhass_lens.domain.mpc.payload import PRICE_DECIMALS, BuildResult, build, derive
from emhass_lens.domain.mpc.sent import deferrables, load_series
from emhass_lens.services.inputs import describe
from emhass_lens.services.prices import area_tz

if TYPE_CHECKING:
    from emhass_lens.container import Container
    from emhass_lens.domain.mpc.inputs import MpcInputs
    from emhass_lens.domain.tariffs.engine import SlotPrice

log = logging.getLogger("emhass_lens.sent_inputs")

MPC_JOB = "emhass.mpc"
LOOK_BACK_RUNS = 50  # runs refused before building have no explain; the newest that has one is within these
MAX_EXTEND_DAYS = 7  # Settings → Price forecast → Extend by goes up to this


class SentInputsService:
    def __init__(self, c: Container) -> None:
        self.c = c

    async def build_now(self) -> tuple[datetime, datetime, str, MpcInputs, BuildResult]:
        """The payload a run starting now would send: (now, anchor, rounding, inputs, result). Nothing is sent."""
        c = self.c
        emhass = c.extras["emhass"]
        now = c.clock.now()
        await c.extras["charger"].refresh_load_profile()
        snapshot = await c.app_db.run(c.extras["inputs"].snapshot, now)
        rounding = emhass.method_ts_round()
        anchor = anchor_slot(now, rounding)
        result = build(
            snapshot,
            anchor,
            slot_floor(now),
            c.settings.current,
            emhass_version=emhass.version_tuple,
            emhass_config=emhass.config,
            model_steps=c.extras["ml"].model_steps(now),
        )
        return now, anchor, rounding, snapshot, result

    async def last_run(self, hours_back: int, beyond: bool = True) -> SentInputs:
        """The newest MPC run's payload (sent, or built in a dry run)."""
        recorder = self.c.recorder
        for run in await recorder.list(job=MPC_JOB, limit=LOOK_BACK_RUNS):
            explain = await _artifact(recorder, run["id"], "explain")
            if not isinstance(explain, dict) or not explain.get("slots"):
                continue
            payload = await _artifact(recorder, run["id"], "request")
            inputs = await _artifact(recorder, run["id"], "inputs")
            plan = await self.c.extras["emhass"].plan_of_run(run["id"])
            return await self._assemble(
                source="last_run",
                run=run,
                sent_at=explain.get("submitted_at") or run.get("started_at"),
                anchor=parse_iso(str(explain.get("anchor"))),
                slots=explain["slots"],
                payload=payload if isinstance(payload, dict) else {},
                inputs=inputs if isinstance(inputs, dict) else {},
                plan=plan,
                hours_back=hours_back,
                beyond=beyond,
            )
        return SentInputs(
            available=False,
            source="last_run",
            timezone=self._tz(),
            run_id=None,
            run_outcome=None,
            run_mode=None,
            sent_at=None,
            anchor=None,
            slots=[],
            load_w=[],
            load_source="none",
            load_plan_generated_at=None,
            load_plan_run_id=None,
            soc_init=None,
            soc_final=None,
            soc_init_reading=None,
            soc_final_reading=None,
            model=None,
            deferrables=[],
            pv_sensors=0,
            pv_slots_missing=0,
            no_export_at_or_below=None,
            measured=[],
            measured_entities={},
        )

    async def preview(self, hours_back: int, beyond: bool = True) -> SentInputs:
        """The payload a run starting now would send."""
        now, anchor, _rounding, snapshot, result = await self.build_now()
        return await self._assemble(
            source="preview",
            run=None,
            sent_at=iso(now),
            anchor=anchor,
            slots=result.explain,
            payload=result.payload,
            inputs=describe(snapshot),
            plan=None,
            hours_back=hours_back,
            beyond=beyond,
        )

    def _tz(self) -> str:
        return str(area_tz(self.c.settings.current))

    async def _assemble(
        self,
        *,
        source: str,
        run: dict[str, Any] | None,
        sent_at: str | None,
        anchor: datetime | None,
        slots: list[dict[str, Any]],
        payload: dict[str, Any],
        inputs: dict[str, Any],
        plan: dict[str, Any] | None,
        hours_back: int,
        beyond: bool,
    ) -> SentInputs:
        c = self.c
        settings = c.settings.current
        explain = [ExplainSlot(**s) for s in slots]
        starts = [parse_iso(s.start) for s in explain]
        if plan is None:
            # no plan from this run (it failed, or this is a preview): the newest plan EMHASS made
            newest = await c.extras["emhass"].plans(1)
            plan = newest[0] if newest else None
        load_from, load_w = load_series(payload, [s for s in starts if s is not None], plan["plan"] if plan else None)
        if load_from == "sent":
            plan = None

        measured: list[MeasuredSlot] = []
        if anchor is not None and hours_back > 0:
            start = anchor - timedelta(hours=hours_back)
            rows = await c.app_db.run(c.extras["measurements"].read, start, anchor)
            # nothing was sent for these slots: the prices that applied, as a payload would have them
            prices = {iso(p.start): p for p in await c.app_db.run(c.extras["prices"].priced, start, None)}
            for k in range(hours_back * 4):
                key = iso(start + k * SLOT) or ""
                values = {q: rows.get(q, {}).get(key) for q in ("load", "pv", "soc")}
                price = prices.get(key)
                measured.append(
                    MeasuredSlot(
                        start=key,
                        **{q: v[0] if v else None for q, v in values.items()},
                        load_cost=round(price.import_price, PRICE_DECIMALS) if price else None,
                        prod_price=round(price.export_price, PRICE_DECIMALS) if price else None,
                        period=price.period if price else None,
                    )
                )

        ahead = await self._ahead(anchor, starts[-1] + SLOT if starts and starts[-1] else anchor, beyond)
        pv = inputs.get("pv") or {}
        m = settings.measurements
        return SentInputs(
            available=True,
            source=source,
            timezone=self._tz(),
            run_id=run["id"] if run else None,
            run_outcome=run.get("outcome") if run else None,
            run_mode=run.get("mode") if run else None,
            sent_at=sent_at,
            anchor=iso(anchor),
            slots=explain,
            load_w=load_w,
            load_source=load_from,
            load_plan_generated_at=str(plan["generated_at"]) if plan else None,
            load_plan_run_id=plan.get("run_id") if plan else None,
            soc_init=_float(payload.get("soc_init")),
            soc_final=_float(payload.get("soc_final")),
            soc_init_reading=_reading(inputs.get("soc_init")),
            soc_final_reading=_reading(inputs.get("soc_final")),
            model=SentModel(
                method=payload.get("load_forecast_method"),
                var_model=payload.get("var_model"),
                num_lags=payload.get("num_lags"),
                historic_days=payload.get("historic_days_to_retrieve"),
            ),
            deferrables=[SentDeferrable(**d) for d in deferrables(payload, inputs.get("deferrable_loads") or [])],
            pv_sensors=len(pv.get("sensors_used") or []),
            pv_slots_missing=int(pv.get("slots_missing") or 0),
            no_export_at_or_below=settings.emhass.mpc.no_export_at_or_below,
            measured=measured,
            measured_entities={q: getattr(m, q).entity for q in ("load", "pv", "soc") if getattr(m, q).entity},
            **ahead,
        )

    async def _ahead(self, anchor: datetime | None, sent_end: datetime | None, beyond: bool) -> dict[str, Any]:
        """After the horizon: the prices and PV as they are now up to the most forecast there can be (`beyond`), and
        where the plan would end with each number of forecast days."""
        c = self.c
        settings = c.settings.current
        source = settings.forecast.source
        out: dict[str, Any] = {
            "forecast_source": source,
            "extend_days": settings.forecast.extend_days if source != "none" else 0,
        }
        if anchor is None or sent_end is None:
            return out
        forecast = c.extras["forecasts"].current()
        stitched = await c.app_db.run(c.extras["prices"].stitched, anchor, forecast, MAX_EXTEND_DAYS)
        priced: list[SlotPrice] = await c.app_db.run(
            partial(c.extras["prices"].priced, anchor, forecast, extend_days=MAX_EXTEND_DAYS)
        )
        # the slots a plan could take: from the anchor until the first gap
        reach: list[SlotPrice] = []
        for p in priced:
            if p.start < anchor:
                continue
            if p.start != (reach[-1].end if reach else anchor):
                break
            reach.append(p)
        out["actual_end"] = iso(stitched.actual_end)
        if beyond:
            pv = c.extras["pv"].current()
            out["beyond"] = [
                BeyondSlot(
                    start=iso(p.start) or "",
                    origin=p.origin,
                    period=p.period,
                    load_cost=round(p.import_price, PRICE_DECIMALS),
                    prod_price=round(p.export_price, PRICE_DECIMALS),
                    pv_w=pv.watts.get(p.start) if pv is not None else None,
                    pv_p10_w=pv.p10_watts.get(p.start) if pv is not None and pv.has_p10 else None,
                )
                for p in reach
                if p.start >= sent_end
            ]
        if source != "none" and stitched.actual_end is not None and reach:
            cap = anchor + SLOT * settings.emhass.mpc.max_horizon
            options = []
            for days in range(1, MAX_EXTEND_DAYS + 1):
                wanted = stitched.actual_end + timedelta(days=days)
                end = min(wanted, reach[-1].end, cap)
                options.append(
                    HorizonOption(
                        days=days,
                        end=iso(end) or "",
                        slots=int((end - anchor) / SLOT),
                        num_lags=derive(settings, days).num_lags,
                        short=end < wanted,
                    )
                )
            out["horizon_options"] = options
        return out


async def _artifact(recorder: Any, run_id: int, kind: str) -> Any:
    try:
        return await recorder.artifact(run_id, kind)
    except KeyError:
        return None


def _float(value: Any) -> float | None:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def _reading(value: Any) -> Reading | None:
    """A Reading from a run's inputs artifact; an older run's may not fit the model."""
    if not isinstance(value, dict):
        return None
    try:
        return Reading(**value)
    except ValidationError:
        log.debug("Ignoring a reading that doesn't fit: %s", value)
        return None
