"""Inverter control from the plan (experimental): decide each slot, compare with the HA automation, optionally apply.

- Off:     nothing happens.
- Dry run: at mm:00:05 the decision for the slot is recorded (rule, why, targets); at mm:00:45 the inverter
           entities are read and compared with it, so you can see how often EMHASS Lens agrees with the
           automation before letting it take over.
- Live:    the decision is applied (input_select, three passive-mode numbers + apply button, feed-in limit + button)
           and read back. Turn the HA automation off first, or both will write.
"""

import asyncio
import logging
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from emhass_lens.core.clock import iso, parse_iso
from emhass_lens.core.slots import slot_floor
from emhass_lens.domain.inverter import Decision, Observed, PlanValues, compare, decide
from emhass_lens.runs.recorder import RunRefused
from emhass_lens.scheduler.core import JobContext

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.inverter")

PLAN_SENSORS = {
    "p_batt": "sensor.p_batt_forecast",
    "p_grid": "sensor.p_grid_forecast",
    "p_pv": "sensor.p_pv_forecast",
    "p_pv_curtailment": "sensor.p_pv_curtailment",
}
ROW_KEYS = {"p_batt": "P_batt", "p_grid": "P_grid", "p_pv": "P_PV", "p_pv_curtailment": "P_PV_curtailment"}


def _updated(state: dict[str, Any] | None) -> datetime | None:
    """When HA last wrote the state (last_reported also moves when the value didn't change)."""
    if not state:
        return None
    stamps = [parse_iso(str(state.get(k))) for k in ("last_reported", "last_updated") if state.get(k)]
    stamps = [t for t in stamps if t is not None]
    return max(stamps) if stamps else None


def _num(state: dict[str, Any] | None) -> float | None:
    try:
        return float((state or {}).get("state"))  # type: ignore[arg-type]
    except TypeError, ValueError:
        return None


class InverterService:
    def __init__(self, c: Container) -> None:
        self.c = c
        self.last: dict[str, Any] | None = None  # {slot, decision, source, run_id, blocked} for the API
        self.last_decision: Decision | None = None
        self.last_compare: dict[str, Any] | None = None

    @property
    def mode(self) -> str:
        return "off" if self.c.boot.safe_mode else self.c.settings.current.inverter.mode

    def active(self) -> bool:
        return self.mode != "off"

    def decided_this_slot(self) -> bool:
        return bool(self.last and self.last.get("slot") == iso(slot_floor(self.c.clock.now())))

    def should_record_decide(self) -> bool:
        """The scheduled decision is only a fallback when no decision was made right after publish."""
        return self.active() and not self.decided_this_slot()

    def entities(self) -> set[str]:
        if self.mode == "off":
            return set()
        e = self.c.settings.current.inverter.entities
        return set(PLAN_SENSORS.values()) | {
            e.charger_mode_select,
            e.enable_boolean,
            e.state_select,
            e.grid_power_number,
            e.battery_max_number,
            e.battery_min_number,
            e.feedin_number,
        } - {""}

    # --- inputs ---------------------------------------------------------------------------------------------
    async def plan_values(self, now: datetime) -> tuple[PlanValues | None, str]:
        """The current slot's plan: EMHASS's published sensors (what the automation reads) when they were
        updated during this slot, otherwise the row of the stored plan that EMHASS publishes now."""
        ha = self.c.extras["ha"]
        slot = slot_floor(now)
        prices = self.c.extras["prices"].priced(slot, self.c.extras["forecasts"].current())
        export = prices[0].export_price if prices and prices[0].start == slot else None
        states = {k: ha.state(eid) for k, eid in PLAN_SENSORS.items()}
        values = {k: _num(st) for k, st in states.items()}
        fresh = all(
            _updated(states[k]) is not None and (_updated(states[k]) or slot) >= slot for k in ("p_batt", "p_grid")
        )
        if fresh and values["p_batt"] is not None and values["p_grid"] is not None:
            return PlanValues(
                values["p_batt"], values["p_grid"], values["p_pv"] or 0.0, values["p_pv_curtailment"] or 0.0, export
            ), "EMHASS sensors (sensor.p_*)"
        row, plan = await self.c.extras["publish"].current_row(now)
        generated = parse_iso(plan["generated_at"]) if plan else None
        max_age = timedelta(minutes=15 * self.c.settings.current.health.plan_max_age_slots)
        if row is None or generated is None or now - generated > max_age:
            return None, "EMHASS's sensors weren't updated for this slot and no recent plan is stored"
        return PlanValues(
            float(row.get(ROW_KEYS["p_batt"]) or 0.0),
            float(row.get(ROW_KEYS["p_grid"]) or 0.0),
            float(row.get(ROW_KEYS["p_pv"]) or 0.0),
            float(row.get(ROW_KEYS["p_pv_curtailment"]) or 0.0),
            export,
        ), "stored EMHASS plan (the sensors weren't updated for this slot yet)"

    def observed(self) -> Observed:
        ha = self.c.extras["ha"]
        e = self.c.settings.current.inverter.entities
        return Observed(
            state=(ha.state(e.state_select) or {}).get("state"),
            grid_power_w=_num(ha.state(e.grid_power_number)),
            battery_max_w=_num(ha.state(e.battery_max_number)),
            battery_min_w=_num(ha.state(e.battery_min_number)),
            feedin_max_w=_num(ha.state(e.feedin_number)),
        )

    def preconditions(self) -> str | None:
        ha = self.c.extras["ha"]
        e = self.c.settings.current.inverter.entities
        mode_state = ha.state(e.charger_mode_select)
        if mode_state is None:
            return f"{e.charger_mode_select} not found"
        if mode_state.get("state") != e.passive_option:
            return f"{e.charger_mode_select} is {mode_state.get('state')!r}, not {e.passive_option!r}"
        enabled_state = ha.state(e.enable_boolean)
        if enabled_state is None:
            return f"{e.enable_boolean} not found"
        if enabled_state.get("state") != "on":
            return f"{e.enable_boolean} is {enabled_state.get('state')!r} (e.g. an mFRR session holds the inverter)"
        return None

    # --- jobs --------------------------------------------------------------------------------------------------
    async def decide_job(self, ctx: JobContext) -> None:
        if ctx.trigger == "schedule" and (not self.active() or self.decided_this_slot()):
            return
        assert ctx.run is not None
        now = self.c.clock.now()
        values, source = await self.plan_values(now)
        if values is None:
            ctx.run.outcome, ctx.run.summary = "noop", f"Nothing to decide: {source}"
            return
        decision = decide(values, self.c.settings.current.inverter.limits)
        blocked = self.preconditions()
        self.last_decision = decision
        self.last = {
            "slot": iso(slot_floor(now)),
            "decision": decision.as_dict(),
            "source": source,
            "run_id": ctx.run.id,
            "blocked": blocked,
        }
        ctx.run.artifact(
            "decision", {**self.last, "values": values.__dict__, "observed_before": self.observed().__dict__}
        )
        text = describe(decision)
        if blocked:
            ctx.run.outcome, ctx.run.summary = "noop", f"Not in control ({blocked}); would: {text}"
            return
        if self.mode != "live":
            ctx.run.outcome, ctx.run.summary = "dry_run", f"Would set {text}"
            return
        await self.apply(ctx, decision, now)

    async def apply(self, ctx: JobContext, decision: Decision, now: datetime) -> None:
        assert ctx.run is not None
        settings = self.c.settings.current
        limits, e = settings.inverter.limits, settings.inverter.entities
        plan = await self.c.extras["emhass"].plans(1)
        generated = parse_iso(plan[0]["generated_at"]) if plan else None
        max_age = timedelta(minutes=15 * settings.health.plan_max_age_slots)
        if generated is None or now - generated > max_age:
            raise RunRefused(f"The plan is stale (made {iso(generated) or 'never'}); not touching the inverter")
        ha = self.c.extras["ha"]
        if not ha.connected:
            raise RunRefused("Not connected to Home Assistant; not touching the inverter")
        # The WebSocket cache can lag (e.g. during a reconnect): re-read the interlocks and targets right now.
        for entity_id in (
            e.charger_mode_select,
            e.enable_boolean,
            e.state_select,
            e.grid_power_number,
            e.battery_max_number,
            e.battery_min_number,
            e.feedin_number,
        ):
            if entity_id:
                state = await ha.get_state(entity_id)
                if state is None:
                    ha.states.pop(entity_id, None)
                else:
                    ha.states[entity_id] = state
        blocked = self.preconditions()
        if blocked:
            raise RunRefused(f"Not in control: {blocked}")
        calls: list[tuple[str, str, dict[str, Any]]] = []
        before = self.observed()
        t = decision.targets
        if t is not None:
            if not (limits.battery_min_w <= t.battery_min_w <= t.battery_max_w <= limits.battery_max_w):
                raise RunRefused(
                    f"Battery limits {t.battery_min_w}…{t.battery_max_w} W are outside the configured range"
                )
            if not (-limits.export_max_w <= t.grid_power_w <= limits.grid_import_max_w):
                raise RunRefused(f"Grid target {t.grid_power_w} W is outside the configured range")
            if e.state_select and before.state != t.state:
                calls.append(("input_select", "select_option", {"entity_id": e.state_select, "option": t.state}))
            if (before.grid_power_w, before.battery_max_w, before.battery_min_w) != (
                float(t.grid_power_w),
                float(t.battery_max_w),
                float(t.battery_min_w),
            ):
                calls += [
                    ("number", "set_value", {"entity_id": e.grid_power_number, "value": t.grid_power_w}),
                    ("number", "set_value", {"entity_id": e.battery_max_number, "value": t.battery_max_w}),
                    ("number", "set_value", {"entity_id": e.battery_min_number, "value": t.battery_min_w}),
                    ("button", "press", {"entity_id": e.apply_button}),
                ]
        if before.feedin_max_w is None or abs(before.feedin_max_w - decision.feedin_max_w) >= 0.5:
            calls += [
                ("number", "set_value", {"entity_id": e.feedin_number, "value": decision.feedin_max_w}),
                ("button", "press", {"entity_id": e.feedin_button}),
            ]
        done = []
        for domain, service, data in calls:
            try:
                await ha.call_service(domain, service, data)
                done.append({"service": f"{domain}.{service}", **data, "ok": True})
            except Exception as exc:
                done.append({"service": f"{domain}.{service}", **data, "ok": False, "error": str(exc)})
                log.error("Inverter call %s.%s failed: %s", domain, service, exc)
        ctx.run.artifact("calls", done)
        result = await self._read_back(decision)
        ctx.run.artifact("readback", result)
        failed = [c for c in done if not c["ok"]]
        if failed or not result["agree"]:
            ctx.run.outcome = "error"
            ctx.run.error = "; ".join(c.get("error", "") for c in failed) or "the inverter doesn't show the targets"
        ctx.run.summary = f"Set {describe(decision)}" if calls else f"Already set: {describe(decision)}"

    async def _read_back(self, decision: Decision, attempts: int = 10, every_s: float = 0.5) -> dict[str, Any]:
        """Re-read the inverter entities until they show the targets (or give up after ~5 s)."""
        ha = self.c.extras["ha"]
        e = self.c.settings.current.inverter.entities
        result: dict[str, Any] = {}
        for attempt in range(attempts):
            for entity_id in (
                e.state_select,
                e.grid_power_number,
                e.battery_max_number,
                e.battery_min_number,
                e.feedin_number,
            ):
                if entity_id:
                    state = await ha.get_state(entity_id)
                    if state is not None:
                        ha.states[entity_id] = state
            result = compare(decision, self.observed())
            if result["agree"] or attempt == attempts - 1:
                break
            await asyncio.sleep(every_s)
        return result

    def compare_job_active(self) -> bool:
        return self.mode == "dry_run"

    async def compare_job(self, ctx: JobContext) -> None:
        if not self.compare_job_active() and ctx.trigger != "manual":
            return
        assert ctx.run is not None
        now = self.c.clock.now()
        last = self.last
        if last is None or last["slot"] != iso(slot_floor(now)):
            ctx.run.outcome, ctx.run.summary = "noop", "No decision for this slot to compare"
            return
        if last.get("blocked"):
            ctx.run.outcome, ctx.run.summary = "noop", f"The automation wasn't in control either ({last['blocked']})"
            return
        decision = self.last_decision
        assert decision is not None
        result = compare(decision, self.observed())
        self.last_compare = {"slot": last["slot"], **result, "decision_run_id": last["run_id"]}
        ctx.run.artifact("comparison", self.last_compare)
        ctx.run.outcome = "ok" if result["agree"] else "mismatch"
        differ = [
            f"{f['field']}: decided {f['decided']}, automation set {f['observed']}"
            for f in result["fields"]
            if not f["same"]
        ]
        ctx.run.summary = "The automation did the same" if result["agree"] else "Differs — " + "; ".join(differ)

    async def agreement(self, hours: int = 24) -> dict[str, Any]:
        since = iso(self.c.clock.now() - timedelta(hours=hours))
        rows = await self.c.runs_db.aquery(
            "SELECT outcome, COUNT(*) AS n FROM run WHERE job = 'inverter.compare' AND started_at >= ? "
            "AND outcome IN ('ok', 'mismatch') GROUP BY outcome",
            (since,),
        )
        counts = {r["outcome"]: r["n"] for r in rows}
        total = counts.get("ok", 0) + counts.get("mismatch", 0)
        return {
            "hours": hours,
            "compared": total,
            "agreed": counts.get("ok", 0),
            "rate": (counts.get("ok", 0) / total) if total else None,
        }

    async def status(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "last": self.last,
            "last_compare": self.last_compare,
            "preconditions": self.preconditions() if self.mode != "off" else None,
            "agreement_24h": await self.agreement(24),
            "agreement_7d": await self.agreement(24 * 7),
        }


def describe(decision: Decision) -> str:
    t = decision.targets
    feed = f"feed-in {decision.feedin_max_w} W"
    if t is None:
        return f"no passive-mode change ({decision.why}); {feed}"
    return (
        f"'{t.state}' (rule {decision.rule}): grid {t.grid_power_w} W, battery {t.battery_min_w}…{t.battery_max_w} W, "
        f"{feed}"
    )
