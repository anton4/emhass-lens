"""Qilowatt market controller (experimental): run Kratt/Fusebox sessions the way the HA automation does.

- Off:    nothing is watched; "Reconcile now" still shows what it would do.
- Shadow: every command change (after a settle time), every minute and every start-up decides like the automation
          "Qilowatt: Master Market Controller", records the decision with its throttle reasoning, and a few seconds
          later compares with what the automation did (session select, enable switch, registers, feed-in). Nothing
          is written.
- Live:   the decision is applied through the shared Sofar writer: the session select and the inverter enable
          switch are kept like the automation keeps them, feed-in first, then the passive-mode registers. A session
          end hands the inverter straight back to the plan: one inverter decision, one write at most; the
          automation's safe state is only the fallback when no fresh plan exists.

Sessions are stored in app.db, so a restart continues or ends them from the current sensors.
"""

import asyncio
import logging
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from emhass_lens.core.clock import iso, parse_iso
from emhass_lens.core.slots import slot_floor
from emhass_lens.domain.market import MarketDecision, MarketInputs, compare_expected, decide, expected_after
from emhass_lens.runs.recorder import RunRefused
from emhass_lens.scheduler.core import JobContext
from emhass_lens.services.ha_values import num, text
from emhass_lens.services.notify import send_mobile
from emhass_lens.settings.model import Settings

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.market")

FEEDIN_SETTLE_S = 5.0  # the automation waits 5 s between the feed-in and the passive-mode registers


@dataclass(frozen=True)
class Session:
    id: int
    direction: str
    source: str | None
    mode: str | None
    power_w: int | None
    started_at: datetime
    updated_at: datetime

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "direction": self.direction,
            "source": self.source,
            "mode": self.mode,
            "power_w": self.power_w,
            "started_at": iso(self.started_at),
            "updated_at": iso(self.updated_at),
        }


class MarketService:
    def __init__(self, c: Container) -> None:
        self.c = c
        self.session: Session | None = None
        self.last: dict[str, Any] | None = None
        self.last_decision: MarketDecision | None = None
        self.last_compare: dict[str, Any] | None = None
        self.expect: dict[str, Any] | None = None  # shadow: a decision waiting to be compared
        self.notice: str | None = None
        self._settle_due: datetime | None = None
        self._settle_entity: str | None = None
        self._settle_task: asyncio.Task[None] | None = None
        self._soc_due: datetime | None = None
        self._soc_task: asyncio.Task[None] | None = None
        self._wake = asyncio.Event()
        self._seen: dict[str, str] = {}
        self._connects = 0

    # --- mode and state -------------------------------------------------------------------------------------------
    @property
    def mode(self) -> str:
        return "off" if self.c.boot.safe_mode else self.c.settings.current.market.mode

    def active(self) -> bool:
        return self.mode != "off"

    def holds_inverter(self) -> bool:
        """True while the App itself runs a session: the plan-driven inverter decision must not write."""
        return self.mode == "live" and self.session is not None

    def session_text(self) -> str:
        s = self.session
        if s is None:
            return "no session"
        local = s.started_at.astimezone(self.c.extras["prices"].tz)
        return f"{s.direction} {s.power_w or 0} W from {s.source or '?'} since {local:%H:%M}"

    def load(self) -> None:
        rows = self.c.app_db.query("SELECT * FROM market_session WHERE ended_at IS NULL ORDER BY id DESC")
        if not rows:
            return
        self.session = _session(rows[0])
        for old in rows[1:]:
            self.c.app_db.execute(
                "UPDATE market_session SET ended_at = ?, end_reason = 'duplicate' WHERE id = ?",
                (iso(self.c.clock.now()), old["id"]),
            )
        log.info("Restored the open market session: %s", self.session_text())

    def _e(self):
        return self.c.settings.current.market.entities

    def _t(self):
        return self.c.settings.current.market.thresholds

    def entities(self) -> set[str]:
        if not self.active():
            return set()
        e = self._e()
        ids = {
            e.source_sensor,
            e.mode_sensor,
            e.powerlimit_sensor,
            e.soc_sensor,
            e.pv_sensor,
            e.enable_boolean,
            e.session_select,
            e.ha_automation,
        } - {""}
        return ids | self.c.extras["sofar"].entities()

    def trigger_entities(self) -> set[str]:
        e = self._e()
        return {e.source_sensor, e.mode_sensor, e.powerlimit_sensor} - {""}

    def _state(self, entity_id: str) -> dict[str, Any] | None:
        return self.c.extras["ha"].state(entity_id) if entity_id else None

    def preconditions(self) -> str | None:
        """Why live mode must not act right now."""
        e, inv = self._e(), self.c.settings.current.inverter.entities
        mode_state = self._state(inv.charger_mode_select)
        if mode_state is None:
            return f"{inv.charger_mode_select} not found"
        if mode_state.get("state") != inv.passive_option:
            return f"{inv.charger_mode_select} is {mode_state.get('state')!r}, not {inv.passive_option!r}"
        enabled = self._state(e.enable_boolean)
        if enabled is None:
            return f"{e.enable_boolean} not found"
        if enabled.get("state") != "on":
            return f"{e.enable_boolean} is {enabled.get('state')!r}"
        if e.ha_automation and (self._state(e.ha_automation) or {}).get("state") == "on":
            return f"{e.ha_automation} is on; turn the automation off before EMHASS Lens runs the sessions"
        return None

    # --- triggers ---------------------------------------------------------------------------------------------------
    async def on_state(self, entity_id: str, state: dict[str, Any] | None) -> None:
        """A command sensor or the SoC changed (the automation's state triggers), after the settle time."""
        if not self.active() or not self.c.extras["ha"].connected:
            return
        stamp = str((state or {}).get("last_updated") or "")
        if self._seen.get(entity_id) == stamp:
            return  # a reconnect or re-watch replayed the same state
        self._seen[entity_id] = stamp
        now = self.c.clock.now()
        if entity_id in self.trigger_entities():
            self._settle_due = now + timedelta(seconds=self._t().settle_s)
            self._settle_entity = entity_id
            self._wake.set()
            if self._settle_task is None or self._settle_task.done():
                self._settle_task = asyncio.create_task(self._settle_loop(), name="market-settle")
        elif entity_id == self._e().soc_sensor:
            value = num(state)
            if value is not None and value < self._t().min_soc:
                if self._soc_due is None:
                    self._soc_due = now + timedelta(seconds=self.c.settings.current.market.soc_low_for_s)
                    if self._soc_task is None or self._soc_task.done():
                        self._soc_task = asyncio.create_task(self._soc_loop(), name="market-soc")
            else:
                self._soc_due = None

    async def _settle_loop(self) -> None:
        while True:
            due = self._settle_due
            if due is None:
                return
            now = self.c.clock.now()
            if now >= due:
                break
            self._wake.clear()
            await self.c.clock.wait(self._wake, (due - now).total_seconds())
        entity = self._settle_entity or "qw"
        self._settle_due, self._settle_entity = None, None
        self.c.scheduler.run_now("market.reconcile", {"trigger_entity": entity}, trigger="event")

    async def _soc_loop(self) -> None:
        while True:
            due = self._soc_due
            if due is None:
                return
            now = self.c.clock.now()
            if now >= due:
                break
            await self.c.clock.wait(asyncio.Event(), (due - now).total_seconds())
        self._soc_due = None
        self.c.scheduler.run_now("market.reconcile", {"trigger_entity": self._e().soc_sensor}, trigger="event")

    async def on_connect(self) -> None:
        self._connects += 1
        if self.active():
            why = "startup" if self._connects == 1 else "reconnect"
            self.c.scheduler.run_now("market.reconcile", {"trigger_entity": why}, trigger="event")

    def stop(self) -> None:
        for task in (self._settle_task, self._soc_task):
            if task is not None and not task.done():
                task.cancel()

    # --- inputs and decisions ---------------------------------------------------------------------------------------
    def _kind(self, trigger_entity: str) -> str:
        if trigger_entity in self.trigger_entities():
            return "qw"
        if trigger_entity == self._e().soc_sensor:
            return "soc"
        return trigger_entity

    def inputs(self, now: datetime, kind: str, trigger_entity: str, force_end: bool = False) -> MarketInputs:
        e = self._e()
        writer = self.c.extras["sofar"]
        regs = writer.registers()
        src = self._state(e.source_sensor)
        lost_for: float | None = None
        if src is not None:
            changed = _stamp(src)
            lost_for = (now - changed).total_seconds() if changed is not None else None
        if self.mode == "live" or not e.session_select:
            session = self.session.direction if self.session else None
        else:
            ha_session = text(self._state(e.session_select))  # shadow follows what the automation keeps
            session = ha_session if ha_session in ("buy", "sell") else None
        return MarketInputs(
            source=text(src),
            mode=text(self._state(e.mode_sensor)),
            powerlimit_w=num(self._state(e.powerlimit_sensor)),
            source_lost_for_s=lost_for,
            soc_pct=num(self._state(e.soc_sensor)),
            pv_power_w=num(self._state(e.pv_sensor)),
            session=session,
            cur_grid_w=regs.grid_power_w,
            cur_battery_max_w=regs.battery_max_w,
            cur_battery_min_w=regs.battery_min_w,
            cur_feedin_w=regs.feedin_max_w,
            since_commit_s=writer.last_commit_age_s("passive", now),
            since_feedin_commit_s=writer.last_commit_age_s("feedin", now),
            trigger_kind=kind,
            trigger_entity=trigger_entity,
            force_end=force_end,
        )

    def _decide(
        self, now: datetime, kind: str, trigger_entity: str, force_end: bool = False
    ) -> tuple[MarketDecision, MarketInputs]:
        inputs = self.inputs(now, kind, trigger_entity, force_end)
        return decide(inputs, self._t(), self.c.settings.current.inverter.limits), inputs

    # --- jobs -----
    def should_record(self) -> bool:
        """Scheduled minute ticks are recorded only while a session is open; event and manual runs always are."""
        return self.active() and self.session is not None

    async def reconcile_job(self, ctx: JobContext) -> None:
        now = self.c.clock.now()
        trigger_entity = str(
            ctx.params.get("trigger_entity") or ("reconcile" if ctx.trigger == "schedule" else "manual")
        )
        kind = "promoted" if ctx.params.get("promoted") else self._kind(trigger_entity)
        force_end = bool(ctx.params.get("force_end"))
        if ctx.run is None:  # an unrecorded probe: a minute tick with no session open
            if not self.active():
                return
            decision, inputs = self._decide(now, kind, trigger_entity)
            self.last = self._last(decision, inputs, trigger_entity, now, None)
            if decision.action != "none" or decision.anomaly:
                self.c.scheduler.run_now(
                    "market.reconcile", {"trigger_entity": trigger_entity, "promoted": True}, trigger="event"
                )
            return
        if not self.active():
            decision, inputs = self._decide(now, kind, trigger_entity, force_end)
            ctx.run.outcome, ctx.run.summary = "noop", f"Market control is off; would: {decision.why}"
            return
        live = self.mode == "live"
        if live:
            if not self.c.extras["ha"].connected:
                raise RunRefused("Not connected to Home Assistant; not touching the inverter")
            await self.c.extras["sofar"].refresh()
            await self._reread_inputs()
        decision, inputs = self._decide(now, kind, trigger_entity, force_end)
        self.last_decision = decision
        self.last = self._last(decision, inputs, trigger_entity, now, ctx.run.id)
        ctx.run.artifact("market_decision", {**self.last, "inputs": inputs.as_dict()})
        if decision.notify:
            result = await send_mobile(self.c, decision.notify, dry_run=not live)
            ctx.run.artifact("notification", result)
        if decision.action == "none":
            ctx.run.outcome, ctx.run.summary = "noop", f"No action: {decision.why}"
            return
        if not live:
            held = " (no write: cooldown)" if decision.throttle.cooldown_block else ""
            ctx.run.outcome, ctx.run.summary = "dry_run", f"Would: {decision.message}{held}"
            if self.mode == "shadow":
                delay = timedelta(seconds=self.c.settings.current.market.compare_delay_s)
                self.expect = {
                    "decision_run_id": ctx.run.id,
                    "expected": expected_after(decision, inputs),
                    "at": now + delay,
                }
                self.c.scheduler.retime("market.compare")
            return
        blocked = self.preconditions()
        if blocked:
            self.last["blocked"] = blocked
            ctx.run.outcome, ctx.run.summary = "noop", f"Not in control ({blocked}); would: {decision.message}"
            return
        await self._apply(ctx, decision, inputs, now)

    def _last(
        self, decision: MarketDecision, inputs: MarketInputs, trigger_entity: str, now: datetime, run_id: int | None
    ) -> dict[str, Any]:
        return {
            "at": iso(now),
            "trigger": trigger_entity,
            "decision": decision.as_dict(),
            "session_before": inputs.session,
            "run_id": run_id,
            "blocked": None,
        }

    async def _reread_inputs(self) -> None:
        ha = self.c.extras["ha"]
        e = self._e()
        for entity_id in (
            e.source_sensor,
            e.mode_sensor,
            e.powerlimit_sensor,
            e.soc_sensor,
            e.enable_boolean,
            e.session_select,
        ):
            if entity_id:
                state = await ha.get_state(entity_id)
                if state is None:
                    ha.states.pop(entity_id, None)
                else:
                    ha.states[entity_id] = state

    # --- shadow: compare with the automation -----------------------------------------------------------------
    def compare_active(self) -> bool:
        return self.mode == "shadow"

    def next_compare(self, after: datetime) -> datetime | None:
        exp = self.expect
        if exp is None or not self.compare_active():
            return None
        at: datetime = exp["at"]
        return at if at > after else after + timedelta(seconds=1)

    def observed_for_compare(self) -> dict[str, Any]:
        e, inv = self._e(), self.c.settings.current.inverter.entities
        regs = self.c.extras["sofar"].registers()
        return {
            "session": text(self._state(e.session_select)) or "none",
            "enable_boolean": text(self._state(inv.enable_boolean)),
            "state": regs.state,
            "grid_power_w": regs.grid_power_w,
            "battery_max_w": regs.battery_max_w,
            "battery_min_w": regs.battery_min_w,
            "feedin_max_w": regs.feedin_max_w,
        }

    async def compare_job(self, ctx: JobContext) -> None:
        assert ctx.run is not None
        exp = self.expect
        if exp is None:
            ctx.run.outcome, ctx.run.summary = "noop", "No pending decision to compare"
            return
        self.expect = None
        self.c.scheduler.retime("market.compare")
        await self.c.extras["sofar"].refresh()
        await self._reread_inputs()
        result = compare_expected(exp["expected"], self.observed_for_compare())
        run_id = exp["decision_run_id"]
        self.last_compare = {
            "at": iso(self.c.clock.now()),
            **result,
            "decision_run_id": run_id,
            "expected": exp["expected"].as_dict(),
        }
        ctx.run.artifact("market_comparison", self.last_compare)
        ctx.run.outcome = "ok" if result["agree"] else "mismatch"
        if result["agree"]:
            ctx.run.summary = f"Decision #{run_id}: the automation did the same"
        else:
            differ = [
                f"{f['field']}: expected {f['decided']}, HA shows {f['observed']}"
                for f in result["fields"]
                if not f["same"]
            ]
            ctx.run.summary = f"Decision #{run_id}: differs — " + "; ".join(differ)

    # --- live -----
    async def _apply(self, ctx: JobContext, decision: MarketDecision, inputs: MarketInputs, now: datetime) -> None:
        assert ctx.run is not None
        writer, ha = self.c.extras["sofar"], self.c.extras["ha"]
        e, inv = self._e(), self.c.settings.current.inverter.entities
        before: list[dict[str, Any]] = []
        want_session = decision.session_after or "none"
        if e.session_select and (text(self._state(e.session_select)) or "none") != want_session:
            before.append(
                {"service": "input_select.select_option", "entity_id": e.session_select, "option": want_session}
            )
        want_enable = decision.enable_boolean_after
        if want_enable and inv.enable_boolean and text(self._state(inv.enable_boolean)) != want_enable:
            before.append({"service": f"input_boolean.turn_{want_enable}", "entity_id": inv.enable_boolean})

        if decision.action in ("buy", "sell"):
            targets = decision.targets if decision.needs_update else None
            feedin = decision.feedin_w if decision.feedin_write else None
            writer.check_limits(decision.targets, feedin)
            if self.session is None or self.session.direction != decision.action:
                await self._start_session(decision, inputs, ctx.run.id, now)
            else:
                await self._touch_session(decision, now)
            result = await writer.commit(
                ctx,
                owner="market",
                targets=targets,
                feedin_w=feedin,
                feedin_first=True,
                feedin_settle_s=FEEDIN_SETTLE_S,
                before_calls=before,
            )
            if not result.ok:
                ctx.run.outcome, ctx.run.error = "error", result.error
            parts = []
            if result.wrote_passive and decision.targets is not None:
                t = decision.targets
                parts.append(f"set '{t.state}', grid {t.grid_power_w} W, battery {t.battery_min_w}…{t.battery_max_w} W")
            if result.wrote_feedin:
                parts.append(f"feed-in {decision.feedin_w} W")
            ctx.run.summary = f"{decision.message}: " + ("; ".join(parts) if parts else "registers unchanged")
            return

        # a session end: hand the inverter straight back to the plan, one write at most
        reason = decision.end_reason
        await self._close_session(reason, ctx.run.id, now)
        done = [await writer.call(ha, call) for call in before]
        await writer.refresh()  # the plan-driven decision checks the enable switch from the cache
        handed = await self._hand_off(ctx, now)
        if handed:
            ctx.run.artifact("calls", done)
            ctx.run.summary = f"{decision.message} Handed the inverter back to the plan."
            return
        targets = decision.targets if decision.needs_update else None
        result = await writer.commit(ctx, owner="market", targets=targets, feedin_w=None, before_calls=[])
        ctx.run.artifact("handback_calls", done)
        if not result.ok:
            ctx.run.outcome, ctx.run.error = "error", result.error
        what = "set the safe state" if result.wrote_passive else "the registers were already safe"
        ctx.run.summary = f"{decision.message} No fresh plan to hand back to: {what}."

    async def _hand_off(self, ctx: JobContext, now: datetime) -> bool:
        """Let the plan-driven decision write this slot's targets. True when it applied them."""
        assert ctx.run is not None
        inverter = self.c.extras["inverter"]
        if inverter.mode != "live":
            return False
        await self.c.scheduler.run_now("inverter.decide", {"after_market": True})
        last = inverter.last_apply
        handed = bool(last and last["ok"] and last["run_id"] > ctx.run.id and last["slot"] == iso(slot_floor(now)))
        external = self.c.extras.get("external")
        if handed and external is not None and self.c.settings.current.external_control.replan:
            self.c.scheduler.run_now("external.resume", {"skip_apply": True})
        return handed

    # --- sessions -----
    async def _start_session(self, decision: MarketDecision, inputs: MarketInputs, run_id: int, now: datetime) -> None:
        if self.session is not None:
            await self._close_session("flipped", run_id, now)

        def insert() -> int:
            cur = self.c.app_db.execute(
                "INSERT INTO market_session (direction, source, mode, power_w, started_at, updated_at, start_run_id)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (decision.action, inputs.source, inputs.mode, decision.qw_power_w, iso(now), iso(now), run_id),
            )
            return int(cur.lastrowid or 0)

        session_id = await self.c.app_db.run(insert)
        self.session = Session(session_id, decision.action, inputs.source, inputs.mode, decision.qw_power_w, now, now)
        log.info("Market session started: %s", self.session_text())
        self.c.bus.publish("market.session", {"event": "started", **self.session.as_dict()})

    async def _touch_session(self, decision: MarketDecision, now: datetime) -> None:
        assert self.session is not None
        self.session = replace(self.session, power_w=decision.qw_power_w, updated_at=now)
        await self.c.app_db.aexecute(
            "UPDATE market_session SET power_w = ?, updated_at = ? WHERE id = ?",
            (decision.qw_power_w, iso(now), self.session.id),
        )

    async def _close_session(self, reason: str, run_id: int | None, now: datetime) -> None:
        if self.session is None:
            return
        ended = self.session
        await self.c.app_db.aexecute(
            "UPDATE market_session SET ended_at = ?, end_reason = ?, end_run_id = ? WHERE id = ?",
            (iso(now), reason, run_id, ended.id),
        )
        self.session = None
        log.info("Market session %d ended (%s)", ended.id, reason)
        self.c.bus.publish("market.session", {"event": "ended", "reason": reason, **ended.as_dict()})

    async def on_mode_change(self, old: Settings, new: Settings, paths: list[str]) -> None:
        if old.market.mode == "live" and new.market.mode != "live" and self.session is not None:
            text_ = self.session_text()
            await self._close_session(f"controller_{new.market.mode}", None, self.c.clock.now())
            self.notice = (
                f"Market control was switched to {new.market.mode} during a session ({text_}); "
                "the inverter was left as it was."
            )
            log.warning(self.notice)
        if new.market.mode != "shadow":
            self.expect = None
            self.c.scheduler.retime("market.compare")
        if self.active() and self.c.extras["ha"].connected:
            self.c.scheduler.run_now("market.reconcile", {"trigger_entity": "settings"}, trigger="event")

    # --- status -----
    async def agreement(self, hours: int = 24) -> dict[str, Any]:
        since = iso(self.c.clock.now() - timedelta(hours=hours))
        rows = await self.c.runs_db.aquery(
            "SELECT outcome, COUNT(*) AS n FROM run WHERE job = 'market.compare' AND started_at >= ? "
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

    async def sessions(
        self, limit: int = 50, since: str | None = None, until: str | None = None
    ) -> list[dict[str, Any]]:
        rows = await self.c.app_db.aquery(
            "SELECT * FROM market_session WHERE (? IS NULL OR started_at >= ?) AND (? IS NULL OR started_at < ?) "
            "ORDER BY id DESC LIMIT ?",
            (since, since, until, until, limit),
        )
        return [
            {
                "id": r["id"],
                "direction": r["direction"],
                "source": r["source"],
                "mode": r["mode"],
                "power_w": r["power_w"],
                "started_at": r["started_at"],
                "updated_at": r["updated_at"],
                "ended_at": r["ended_at"],
                "end_reason": r["end_reason"],
            }
            for r in rows
        ]

    async def status(self) -> dict[str, Any]:
        e, inv = self._e(), self.c.settings.current.inverter.entities
        writer = self.c.extras["sofar"]
        return {
            "mode": self.mode,
            "session": self.session.as_dict() if self.session else None,
            "last": self.last,
            "last_compare": self.last_compare,
            "preconditions": self.preconditions() if self.mode == "live" else None,
            "sensors": {
                "source": text(self._state(e.source_sensor)),
                "mode": text(self._state(e.mode_sensor)),
                "powerlimit_w": num(self._state(e.powerlimit_sensor)),
                "soc_pct": num(self._state(e.soc_sensor)),
                "pv_w": num(self._state(e.pv_sensor)),
                "ha_session": text(self._state(e.session_select)),
                "enable_boolean": text(self._state(inv.enable_boolean)),
                "settle_pending": self._settle_due is not None,
            },
            "agreement_24h": await self.agreement(24),
            "agreement_7d": await self.agreement(24 * 7),
            "wear_24h": await writer.wear(24),
            "wear_7d": await writer.wear(24 * 7),
            "notice": self.notice,
        }


def _session(row: dict[str, Any]) -> Session:
    return Session(
        int(row["id"]),
        str(row["direction"]),
        row["source"],
        row["mode"],
        row["power_w"],
        parse_iso(row["started_at"]) or datetime.now(UTC),
        parse_iso(row["updated_at"]) or datetime.now(UTC),
    )


def _stamp(state: dict[str, Any]) -> datetime | None:
    for key in ("last_changed", "last_updated"):
        value = state.get(key)
        if value:
            try:
                return parse_iso(str(value))
            except ValueError:
                return None
    return None
