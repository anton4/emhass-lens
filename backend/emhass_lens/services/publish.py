"""Publishes the plan at the start of each slot (live mode) and tells Home Assistant about it.

publish-data makes EMHASS write its sensor.p_* entities for the slot that just started. Right after,
EMHASS Lens fires `emhass_lens_plan_published` with the same values, so an automation can react to
the event instead of polling the sensors on a fixed second.
"""

import logging
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from emhass_lens.core.clock import iso, parse_iso
from emhass_lens.core.slots import slot_floor
from emhass_lens.domain.mpc.anchor import published_row
from emhass_lens.scheduler.core import JobContext

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.publish")

EVENT = "emhass_lens_plan_published"
ROW_FIELDS = {
    "P_batt": "p_batt_w",
    "P_grid": "p_grid_w",
    "P_PV": "p_pv_w",
    "P_PV_curtailment": "p_pv_curtailment_w",
    "P_Load": "p_load_w",
    "SOC_opt": "soc_opt",
    "P_deferrable0": "p_deferrable0_w",
    "P_deferrable1": "p_deferrable1_w",
}


class PublishService:
    def __init__(self, c: Container) -> None:
        self.c = c
        self.last_published_at = None
        self.last_event: dict[str, Any] | None = None

    def _held(self) -> str | None:
        """Why publishing must wait: a market session owns the inverter (see services/external.py)."""
        external = self.c.extras.get("external")
        return external.hold_text() if external is not None and external.holding else None

    def active(self) -> bool:
        settings = self.c.settings.current.emhass
        mpc = self.c.extras["mpc"]
        return (
            mpc.mode == "live"
            and settings.publish.enabled
            and settings.mpc.auto
            and not mpc.legacy_driving()
            and self._held() is None
        )

    async def run(self, ctx: JobContext) -> None:
        if not self.active() and ctx.trigger != "manual":
            return
        assert ctx.run is not None
        emhass = self.c.extras["emhass"]
        settings = self.c.settings.current
        held = self._held()
        if held is not None:
            ctx.run.outcome, ctx.run.summary = "noop", f"Held: {held}"
            return
        if self.c.extras["mpc"].mode != "live":
            ctx.run.outcome, ctx.run.summary = "noop", "Only publishes in live mode"
            return
        async with emhass.action_lock:
            result = await emhass.client.action("publish-data", {}, settings.emhass.timeouts.publish)
        ctx.run.artifact(
            "response",
            {
                "http_status": result.http_status,
                "duration_ms": result.duration_ms,
                "error": result.error,
                "body": result.body[:5000],
            },
        )
        if result.error:
            ctx.run.outcome, ctx.run.error = "error", result.error
            return
        now = self.c.clock.now()
        row, plan = await self.current_row(now)
        event = self.event_data(now, row, plan)
        self.last_published_at, self.last_event = now, event
        ctx.run.artifact("event", event)
        if settings.outputs.fire_event:
            try:
                await self.c.extras["ha"].fire_event(EVENT, event)
            except Exception as exc:
                log.warning("Firing %s failed: %s", EVENT, exc)
                ctx.run.summary = f"Published, but the event failed: {exc}"
        outputs = self.c.extras.get("outputs")
        if outputs is not None:
            try:
                await outputs.refresh()
            except Exception as exc:  # MQTT trouble mustn't hide that EMHASS published
                log.warning("Refreshing the MQTT entities failed: %s", exc)
        if row is None:
            ctx.run.summary = ctx.run.summary or "Published; the stored plan has no row for this slot"
        else:
            local = (parse_iso(str(row.get("timestamp"))) or slot_floor(now)).astimezone(self.c.extras["prices"].tz)
            ctx.run.summary = ctx.run.summary or (
                f"Published {local:%H:%M}: {battery(row.get('P_batt'))}, {grid(row.get('P_grid'))}"
            )
        self.c.bus.publish("plan.published", event)
        inverter = self.c.extras.get("inverter")
        if inverter is not None and inverter.active() and ctx.params.get("chain_inverter", True):
            # decide on the values just published, not on a fixed second (a re-plan after a market session
            # passes chain_inverter=False: the inverter keeps the targets it just got, one write per session end)
            self.c.scheduler.run_now("inverter.decide", {"after_publish": True})
        charger = self.c.extras.get("charger")
        if charger is not None and charger.active():
            self.c.scheduler.run_now("charger.decide", {"trigger": "emhass_update", "after_publish": True})

    async def current_row(self, now: Any) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        """The row publish-data shows now: chosen exactly the way EMHASS chooses it, so the event matches
        EMHASS's sensor.p_* values."""
        plans = await self.c.extras["emhass"].plans(1)
        if not plans:
            return None, None
        plan = plans[0]
        rows = [r for r in plan["plan"] if parse_iso(str(r.get("timestamp"))) is not None]
        stamps = [parse_iso(str(r.get("timestamp"))) or now for r in rows]
        index = published_row(stamps, now, self.c.extras["emhass"].method_ts_round())
        return (rows[index] if index is not None else None), plan

    def event_data(self, now: Any, row: dict[str, Any] | None, plan: dict[str, Any] | None) -> dict[str, Any]:
        row_start = parse_iso(str(row.get("timestamp"))) if row else None
        slot = row_start or slot_floor(now)
        data: dict[str, Any] = {
            "slot_start": iso(slot),
            "slot_end": iso(slot + timedelta(minutes=15)),
            "plan_generated_at": plan["generated_at"] if plan else None,
            "run_id": plan.get("run_id") if plan else None,
            "current": {new: row.get(old) for old, new in ROW_FIELDS.items() if row and old in row},
        }
        prices = self.c.extras["prices"].priced(slot, self.c.extras["forecasts"].current())
        if prices and prices[0].start == slot:
            data["price"] = {"import": round(prices[0].import_price, 5), "export": round(prices[0].export_price, 5)}
        return data


def battery(p_batt: Any) -> str:
    """EMHASS sign convention: P_batt > 0 discharges the battery, < 0 charges it."""
    if p_batt is None:
        return "battery —"
    kw = float(p_batt) / 1000
    if abs(kw) < 0.05:
        return "battery idle"
    return f"battery {'discharges' if kw > 0 else 'charges'} {abs(kw):.1f} kW"


def grid(p_grid: Any) -> str:
    """P_grid > 0 imports from the grid, < 0 exports."""
    if p_grid is None:
        return "grid —"
    kw = float(p_grid) / 1000
    if abs(kw) < 0.05:
        return "grid ~0"
    return f"{'imports' if kw > 0 else 'exports'} {abs(kw):.1f} kW"
