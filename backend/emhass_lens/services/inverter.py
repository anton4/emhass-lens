"""Inverter control from the plan (experimental): decide each slot, compare with the HA automation, optionally apply.

- Off:     nothing happens.
- Dry run: at mm:00:05 the decision for the slot is recorded (rule, why, targets); at mm:00:45 the inverter
           entities are read and compared with it, so you can see how often EMHASS Lens agrees with the
           automation before letting it take over.
- Live:    the decision is applied (input_select, three passive-mode numbers + apply button, feed-in limit + button)
           and read back. Turn the HA automation off first, or both will write.
"""

import logging
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from emhass_lens.core.clock import iso, parse_iso
from emhass_lens.core.slots import slot_floor
from emhass_lens.domain.drift import DriftTracker, assess
from emhass_lens.domain.drift import describe as describe_drift
from emhass_lens.domain.inverter import Decision, Observed, PlanValues, compare, compare_targets, decide
from emhass_lens.runs.recorder import RunRefused
from emhass_lens.scheduler.core import JobContext
from emhass_lens.services.ha_values import num as _num
from emhass_lens.services.ha_values import updated as _updated

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


class InverterService:
    def __init__(self, c: Container) -> None:
        self.c = c
        self.last: dict[str, Any] | None = None  # {slot, decision, source, run_id, blocked} for the API
        self.last_decision: Decision | None = None
        self.last_compare: dict[str, Any] | None = None
        self.last_apply: dict[str, Any] | None = None  # {slot, run_id, ok, wrote}: the newest live write
        self.last_refusal: dict[str, Any] | None = None  # {slot, why}: the newest live decision that wasn't applied
        self.drift = DriftTracker()
        self.drift_checked_at: datetime | None = None
        self._fight_logged = False

    @property
    def mode(self) -> str:
        return "off" if self.c.boot.safe_mode else self.c.settings.current.inverter.mode

    def active(self) -> bool:
        return self.mode != "off"

    def applied_this_slot(self) -> bool:
        """A live write for the current slot succeeded (or found everything already set)."""
        slot = iso(slot_floor(self.c.clock.now()))
        return bool(self.last_apply and self.last_apply.get("slot") == slot and self.last_apply.get("ok"))

    def refusal_this_slot(self) -> str | None:
        slot = iso(slot_floor(self.c.clock.now()))
        if self.last_refusal and self.last_refusal.get("slot") == slot:
            return str(self.last_refusal.get("why"))
        return None

    def decided_this_slot(self) -> bool:
        return bool(self.last and self.last.get("slot") == iso(slot_floor(self.c.clock.now())))

    def should_record_decide(self) -> bool:
        """The scheduled decision is only a fallback when no decision was made right after publish."""
        return self.active() and not self.decided_this_slot()

    def entities(self) -> set[str]:
        if self.mode == "off":
            return set()
        return set(PLAN_SENSORS.values()) | self.c.extras["sofar"].entities()

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
        return self.c.extras["sofar"].observed()

    def preconditions(self) -> str | None:
        ha = self.c.extras["ha"]
        e = self.c.settings.current.inverter.entities
        external = self.c.extras.get("external")
        if external is not None and external.holding:
            return f"an mFRR market session holds the inverter ({external.hold_text()})"
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
        catch_up = " (catch-up after Home Assistant came back)" if ctx.params.get("catch_up") else ""
        if blocked:
            if self.mode == "live":
                self.last_refusal = {"slot": self.last["slot"], "why": blocked}
            ctx.run.outcome, ctx.run.summary = "noop", f"Not in control ({blocked}); would: {text}{catch_up}"
            return
        if self.mode != "live":
            ctx.run.outcome, ctx.run.summary = "dry_run", f"Would set {text}"
            return
        try:
            await self.apply(ctx, decision, now)
        except RunRefused as exc:
            self.last_refusal = {"slot": self.last["slot"], "why": str(exc)}
            raise RunRefused(f"{exc}{catch_up}") from exc
        if catch_up and ctx.run.summary:
            ctx.run.summary += catch_up
        if ctx.params.get("drift"):
            ctx.run.summary = f"Drift: {ctx.params['drift']}; set back · {ctx.run.summary}"

    async def apply(self, ctx: JobContext, decision: Decision, now: datetime) -> None:
        assert ctx.run is not None
        settings = self.c.settings.current
        plan = await self.c.extras["emhass"].plans(1)
        generated = parse_iso(plan[0]["generated_at"]) if plan else None
        max_age = timedelta(minutes=15 * settings.health.plan_max_age_slots)
        if generated is None or now - generated > max_age:
            raise RunRefused(f"The plan is stale (made {iso(generated) or 'never'}); not touching the inverter")
        ha = self.c.extras["ha"]
        if not ha.connected:
            raise RunRefused("Not connected to Home Assistant; not touching the inverter")
        writer = self.c.extras["sofar"]
        await writer.refresh()  # the WebSocket cache can lag (e.g. during a reconnect): re-read before writing
        blocked = self.preconditions()
        if blocked:
            raise RunRefused(f"Not in control: {blocked}")
        writer.check_limits(decision.targets, decision.feedin_max_w)
        result = await writer.commit(ctx, owner="plan", targets=decision.targets, feedin_w=decision.feedin_max_w)
        wrote = result.wrote_passive or result.wrote_feedin
        self.last_apply = {"slot": iso(slot_floor(now)), "run_id": ctx.run.id, "ok": result.ok, "wrote": wrote}
        if not result.ok:
            ctx.run.outcome = "error"
            ctx.run.error = result.error
        ctx.run.summary = f"Set {describe(decision)}" if wrote else f"Already set: {describe(decision)}"

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

    # --- every minute: what drifted since this slot's write ---------------------------------------------------
    async def verify_job(self, ctx: JobContext) -> None:
        """Compare the registers with this slot's applied targets and set back what something else changed (with the
        guards in domain/drift.py); re-decide a slot whose decision was refused for a passing reason."""
        if self.mode != "live" or not self.c.settings.current.inverter.drift_check:
            return
        now = self.c.clock.now()
        self.drift_checked_at = now
        if not self.c.extras["ha"].connected or self.preconditions():
            return  # not ours to correct: a market session, another inverter mode, the enable switch off
        if self.applied_this_slot() and self.last_decision is not None:
            result = compare_targets(self.last_decision.targets, self.last_decision.feedin_max_w, self.observed())
            differing = {
                r["field"]: (r["observed"], r["decided"])
                for r in result["fields"]
                if not r["same"] and r["observed"] is not None  # an entity that can't be read isn't drift
            }
            writer = self.c.extras["sofar"]
            last_write = max(writer.last_commit.values(), default=None)
            self.drift, action = assess(self.drift, now, differing, last_write)
            if action == "correct":
                what = describe_drift(differing, DRIFT_LABELS)
                log.info("The inverter drifted (%s); setting it back", what)
                self.c.scheduler.run_now("inverter.decide", {"drift": what}, trigger="event")
            elif action == "fighting" and not self._fight_logged:
                self._fight_logged = True
                log.warning(
                    "Something else keeps changing the inverter's %s; EMHASS Lens stops correcting it for an hour",
                    _field_name((self.drift.fighting or {}).get("field")),
                )
            if self.drift.fighting is None:
                self._fight_logged = False
            return
        if transient_block(self.refusal_this_slot()):
            self.c.scheduler.run_now("inverter.decide", {"catch_up": True}, trigger="event")

    def drift_status(self) -> dict[str, Any]:
        now = self.c.clock.now()
        fighting = self.drift.fighting
        return {
            "enabled": self.mode == "live" and self.c.settings.current.inverter.drift_check,
            "checked_at": iso(self.drift_checked_at),
            "corrections_1h": self.drift.corrections_since(now - timedelta(hours=1)),
            "fighting": (
                {"field": _field_name(fighting["field"]), "since": iso(fighting["since"]), "count": fighting["count"]}
                if fighting
                else None
            ),
        }

    async def status(self) -> dict[str, Any]:
        return {
            "drift": self.drift_status(),
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


DRIFT_LABELS = {
    "state": ("passive state", ""),
    "grid_power_w": ("grid power", "W"),
    "battery_max_w": ("battery max", "W"),
    "battery_min_w": ("battery min", "W"),
    "feedin_max_w": ("feed-in limit", "W"),
}


def _field_name(field: str | None) -> str:
    return DRIFT_LABELS.get(field or "", (field or "settings", ""))[0]


TRANSIENT = ("not found", "'unavailable'", "'unknown'", "Not connected to Home Assistant")


def transient_block(reason: str | None) -> bool:
    """A refusal that goes away by itself once Home Assistant has started: an entity that isn't loaded yet, or the
    connection itself. A stale plan, another inverter mode or the automation switch being off are not."""
    return bool(reason) and any(part in str(reason) for part in TRANSIENT)
