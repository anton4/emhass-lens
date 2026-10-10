"""EV charger control (experimental): decide like the HA automation, compare with it in dry run, apply in live mode.

- Off:     nothing is scheduled; "Decide now" still shows what it would do.
- Dry run: every decision is recorded (rule, why, target, the calls it would make, the message it would send)
           and compared a few seconds later with what the Home Assistant automation did to the charger.
- Live:    the decision is applied (start/stop buttons, the current limit, the target SoC, a phone message)
           and read back. Turn the HA automation off first, or set it as the interlock under Charger entities.

Three things trigger a decision, like the automation's three triggers: the publish of a new slot (and a change of
EMHASS's EV power sensor), the minute tick for Excess Solar, and the target-SoC stop after its holding time.
"""

import asyncio
import logging
from dataclasses import replace
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from emhass_lens.core.clock import iso, parse_iso
from emhass_lens.core.slots import slot_floor
from emhass_lens.domain.charger import (
    ChargerDecision,
    ChargerInputs,
    ChargerObserved,
    SocTracker,
    compare,
    decide,
    describe,
    numbers,
    soc_stop_at,
    soc_stop_due,
    track_soc,
)
from emhass_lens.domain.drift import DriftTracker, assess
from emhass_lens.domain.drift import describe as describe_drift
from emhass_lens.domain.ev_reserve import (
    EvReserve,
    blocker,
    house_load_profile,
    inactive,
    load_by_slot,
    plan_reserve,
)
from emhass_lens.domain.pv_solcast import PvForecast
from emhass_lens.runs.recorder import RunRefused
from emhass_lens.scheduler.core import JobContext
from emhass_lens.services.ha_values import integer, last_updated, num, number, text, updated
from emhass_lens.services.notify import send_mobile
from emhass_lens.settings.model import ChargerLimits

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.charger")

Call = dict[str, Any]


class ChargerService:
    def __init__(self, c: Container) -> None:
        self.c = c
        self.last: dict[str, Any] | None = None  # the newest decision, for the API
        self.last_decision: ChargerDecision | None = None
        self.last_compare: dict[str, Any] | None = None
        self.last_tick: dict[str, Any] | None = None
        self.last_emhass_slot: str | None = None  # the slot whose publish already triggered a decision
        self.last_deferrable_seen: str | None = None  # last_updated of the EV power sensor we reacted to
        self.emhass_asked: tuple[str | None, int | None] | None = None  # (slot, EV power W) last asked for
        self.soc = SocTracker()
        self.expect: dict[str, Any] | None = None  # a dry-run decision waiting to be compared
        self._last_limit: float | None = None  # the current limit as last seen (dry run: spotting the automation)
        self.last_applied: dict[str, Any] | None = None  # {target_a, at}: the limit EMHASS Lens last set (live)
        self.drift = DriftTracker()
        self.drift_checked_at: datetime | None = None
        self._fight_logged = False
        self._load_profile: dict[datetime, float] = {}  # EMHASS's house load forecast, from the newest plan
        self._profile_plan: str | None = None  # generated_at of the plan the profile came from

    @property
    def mode(self) -> str:
        return "off" if self.c.boot.safe_mode else self.c.settings.current.charger.mode

    def active(self) -> bool:
        return self.mode != "off"

    @property
    def limits(self) -> ChargerLimits:
        return self.c.settings.current.charger.limits

    def entities(self) -> set[str]:
        e = self.c.settings.current.charger.entities
        reserve: set[str] = set()
        if self.c.settings.current.charger.pv_reserve.enabled:  # the reservation reads these even when Off
            reserve = {
                e.charge_mode_select,
                e.target_soc_number,
                e.max_solar_current_number,
                e.charging_state_sensor,
                e.car_soc_sensor,
            } - {""}
        if not self.active():
            return reserve
        return reserve | {
            e.charge_mode_select,
            e.target_soc_number,
            e.max_solar_current_number,
            e.charging_state_sensor,
            e.current_limit_number,
            e.car_soc_sensor,
            e.pv_power_sensor,
            e.pv_potential_sensor,
            e.house_load_sensor,
            e.deferrable_sensor,
            e.automation,
        } - {""}

    def should_record_decide(self) -> bool:
        """The scheduled decision is only a fallback when the publish didn't trigger one this slot."""
        return self.active() and self.last_emhass_slot != iso(slot_floor(self.c.clock.now()))

    def compare_job_active(self) -> bool:
        return self.mode == "dry_run"

    # --- inputs -----------------------------------------------------------------------------------------------
    def _state(self, entity_id: str) -> dict[str, Any] | None:
        return self.c.extras["ha"].state(entity_id) if entity_id else None

    async def inputs(self, now: datetime) -> tuple[ChargerInputs, str]:
        """The automation's variables, from the watched entities with the same defaults as its Jinja filters."""
        e = self.c.settings.current.charger.entities
        p_state = self._state(e.deferrable_sensor)
        slot = slot_floor(now)
        stamp = updated(p_state)
        p = num(p_state)
        if p is not None and stamp is not None and stamp >= slot:
            source = f"{e.deferrable_sensor} (published this slot)"
        else:
            row, plan = await self.c.extras["publish"].current_row(now)
            generated = parse_iso(plan["generated_at"]) if plan else None
            max_age = timedelta(minutes=15 * self.c.settings.current.health.plan_max_age_slots)
            fresh = row is not None and generated is not None and now - generated <= max_age
            if fresh and row is not None and row.get("P_deferrable0") is not None:
                p, source = float(row["P_deferrable0"]), "the stored EMHASS plan"
            elif p is not None:
                source = f"{e.deferrable_sensor} (not updated this slot)"
            else:
                source = "no EV power value (no sensor, no recent plan)"
        inputs = ChargerInputs(
            charge_mode=text(self._state(e.charge_mode_select)),
            state_raw=integer(self._state(e.charging_state_sensor), -1),
            current_limit_a=number(self._state(e.current_limit_number), 0.0),
            soc=number(self._state(e.car_soc_sensor), 0.0),
            target_soc=num(self._state(e.target_soc_number)),
            p_deferrable0_w=p,
            solar_limit_a=integer(self._state(e.max_solar_current_number), 16),
            pv_actual_w=number(self._state(e.pv_power_sensor), 0.0),
            pv_actual_updated=last_updated(self._state(e.pv_power_sensor)),
            pv_potential_w=number(self._state(e.pv_potential_sensor), 0.0),
            pv_potential_updated=last_updated(self._state(e.pv_potential_sensor)),
            house_load_w=number(self._state(e.house_load_sensor), 0.0),
        )
        return inputs, source

    def observed(self) -> ChargerObserved:
        e = self.c.settings.current.charger.entities
        state = self._state(e.charging_state_sensor)
        return ChargerObserved(
            current_limit_a=num(self._state(e.current_limit_number)),
            state_raw=integer(state, -1) if state is not None else None,
            target_soc=num(self._state(e.target_soc_number)),
        )

    def preconditions(self) -> str | None:
        """Why live mode must not act right now."""
        e = self.c.settings.current.charger.entities
        if e.automation:
            state = self._state(e.automation)
            if state is not None and state.get("state") == "on":
                return f"{e.automation} is on; turn the automation off before EMHASS Lens drives the charger"
        return None

    async def _reread(self, entity_ids: list[str]) -> None:
        """The WebSocket cache can lag: re-read these over REST right before deciding to write or comparing."""
        ha = self.c.extras["ha"]
        for entity_id in entity_ids:
            if entity_id:
                state = await ha.get_state(entity_id)
                if state is None:
                    ha.states.pop(entity_id, None)
                else:
                    ha.states[entity_id] = state

    def _decide(self, inputs: ChargerInputs, now: datetime, soc_due: bool) -> ChargerDecision:
        e = self.c.settings.current.charger.entities
        return decide(inputs, now, self.limits, soc_due, emhass_option=e.emhass_option, solar_option=e.solar_option)

    # --- the SoC stop's clock -----------------------------------------------------------------------------------
    def next_soc_stop(self, after: datetime) -> datetime | None:
        if not self.active():
            return None
        at = soc_stop_at(self.soc, self.limits.soc_for_s)
        if at is None:
            return None
        return at if at > after else after + timedelta(seconds=5)  # overdue: fire soon, and again until handled

    def _track(self, inputs: ChargerInputs, now: datetime) -> None:
        before = self.soc
        self.soc = track_soc(self.soc, inputs, now)
        if self.soc != before:
            self.c.scheduler.retime("charger.soc_stop")

    # --- jobs -----------------------------------------------------------------------------------------------------
    async def tick_job(self, ctx: JobContext) -> None:
        """Every minute (unrecorded): Excess Solar, the SoC clock, and EMHASS mode when the charger's state changed."""
        if not self.active():
            return
        now = self.c.clock.now()
        inputs, source = await self.inputs(now)
        self._track(inputs, now)
        due = soc_stop_due(self.soc, now, self.limits.soc_for_s)
        decision = self._decide(inputs, now, due)
        self.last_tick = {
            "at": iso(now),
            "rule": decision.rule,
            "why": decision.why,
            "derived": decision.derived.__dict__,
            "source": source,
        }
        if self._drift_handled(decision, now, due):
            return
        if decision.action == "none" or self._already_shown(decision, inputs):
            return
        trigger = "soc_limit" if decision.action == "stop_soc" else "solar_update"
        self.c.scheduler.run_now("charger.decide", {"trigger": trigger, "soc_due": due})

    def _drift_handled(self, decision: ChargerDecision, now: datetime, due: bool) -> bool:
        """Live: the minute's decision asks for the limit EMHASS Lens already set while the charger shows another,
        so something else changed it (the car's or the charger's app, an OCPP backend). Set it back only with the
        guards in domain/drift.py. True when this minute is handled here (corrected, or waiting)."""
        self.drift_checked_at = now
        last, target = self.last_applied, decision.target_current_a
        live = self.mode == "live" and self.c.settings.current.charger.drift_check
        if not live or last is None or target is None or target != last["target_a"]:
            if decision.action == "none":
                self.drift, _ = assess(self.drift, now, {}, None)  # in sync
            return False  # nothing to judge, or a new target: the plan or the sun changed
        observed = self.observed().current_limit_a
        differing = {} if observed is None or abs(observed - target) < 0.5 else {"current_limit_a": (observed, target)}
        self.drift, action = assess(self.drift, now, differing, last["at"], settle_s=90)
        if action == "ok":
            return False  # the limit is right; anything else (a start) goes the usual way
        if action == "correct":
            what = describe_drift(differing, {"current_limit_a": ("limit", "A")})
            log.info("The charger's current limit drifted (%s); setting it back", what)
            self.c.scheduler.run_now("charger.decide", {"trigger": "drift", "drift": what, "soc_due": due})
        elif action == "fighting" and not self._fight_logged:
            self._fight_logged = True
            log.warning("Something else keeps changing the charger's current limit; EMHASS Lens stops for an hour")
        if self.drift.fighting is None:
            self._fight_logged = False
        return True

    def drift_status(self) -> dict[str, Any]:
        now = self.c.clock.now()
        fighting = self.drift.fighting
        return {
            "enabled": self.mode == "live" and self.c.settings.current.charger.drift_check,
            "checked_at": iso(self.drift_checked_at),
            "corrections_1h": self.drift.corrections_since(now - timedelta(hours=1)),
            "fighting": (
                {"field": "current limit", "since": iso(fighting["since"]), "count": fighting["count"]}
                if fighting
                else None
            ),
        }

    def _already_shown(self, decision: ChargerDecision, inputs: ChargerInputs) -> bool:
        """Don't repeat a pause every minute while the charger already shows 0 A (the automation would)."""
        return decision.action == "pause" and abs(inputs.current_limit_a) < 0.5 and self.last_decision is not None

    async def soc_stop_job(self, ctx: JobContext) -> None:
        if self.active() and soc_stop_due(self.soc, self.c.clock.now(), self.limits.soc_for_s):
            self.c.scheduler.run_now("charger.decide", {"trigger": "soc_limit", "soc_due": True})

    async def decide_job(self, ctx: JobContext) -> None:
        now = self.c.clock.now()
        slot = iso(slot_floor(now))
        if ctx.trigger == "schedule" and (not self.active() or self.last_emhass_slot == slot):
            return
        assert ctx.run is not None
        trigger = str(ctx.params.get("trigger") or ("manual" if ctx.trigger == "manual" else "emhass_update"))
        live = self.mode == "live"
        if live:
            if not self.c.extras["ha"].connected:
                raise RunRefused("Not connected to Home Assistant; not touching the charger")
            await self._reread(sorted(self.entities()))
        inputs, source = await self.inputs(now)
        self._track(inputs, now)
        due = bool(ctx.params.get("soc_due")) or soc_stop_due(self.soc, now, self.limits.soc_for_s)
        decision = self._decide(inputs, now, due)
        before = self.observed()
        self.last_decision = decision
        self.last = {
            "at": iso(now),
            "slot": slot,
            "trigger": trigger,
            "source": source,
            "decision": decision.as_dict(),
            "inputs": inputs.as_dict(),
            "run_id": ctx.run.id,
            "blocked": None,
        }
        if trigger == "emhass_update":
            self.last_emhass_slot = slot
        ctx.run.artifact(
            "charger_decision",
            {**self.last, "observed_before": before.as_dict(), "soc": self.soc.as_dict(self.limits.soc_for_s)},
        )
        facts = numbers(decision, inputs)
        if decision.action == "none":
            ctx.run.outcome, ctx.run.summary = "noop", f"Nothing to do: {decision.why} · {facts}"
            return
        if decision.action == "stop_soc":
            self.soc = replace(self.soc, fired=True)
            self.c.scheduler.retime("charger.soc_stop")
        calls = self._calls(decision)
        what = describe(decision)
        if live:
            blocked = self.preconditions()
            if blocked:
                self.last["blocked"] = blocked
                ctx.run.outcome, ctx.run.summary = "noop", f"Not in control ({blocked}); would: {what} · {facts}"
                return
            await self.apply(ctx, decision, calls, facts)
            if ctx.params.get("drift"):
                ctx.run.summary = f"Drift: {ctx.params['drift']}; set back · {ctx.run.summary}"
            return
        ctx.run.artifact("charger_calls", [{**call, "ok": None, "dry_run": True} for call in calls])
        ctx.run.outcome = "dry_run"
        ctx.run.summary = f"Would {what}" + (" (control is off)" if self.mode == "off" else "") + f" · {facts}"
        if self.mode == "dry_run":
            window = self.limits.soc_compare_window_s if decision.action == "stop_soc" else self.limits.compare_window_s
            self.expect = {
                "decision_run_id": ctx.run.id,
                "decision": decision,
                "at": now + timedelta(seconds=self.limits.compare_delay_s),
                "window_s": window,
            }
            self.c.scheduler.retime("charger.compare")

    def _calls(self, decision: ChargerDecision) -> list[Call]:
        e = self.c.settings.current.charger.entities
        limit = {"service": "number.set_value", "entity_id": e.current_limit_number, "value": decision.target_current_a}
        notify: list[Call] = [{"service": "notify", "message": decision.notify}] if decision.notify else []
        if decision.action == "stop_soc":
            return [
                {"service": "button.press", "entity_id": e.stop_button},
                limit,
                *notify,
                {"service": "input_number.set_value", "entity_id": e.target_soc_number, "value": 100},
            ]
        if decision.action == "start":
            return [{"service": "button.press", "entity_id": e.start_button}, limit, *notify]
        return [limit, *notify]  # set_current, pause

    async def apply(self, ctx: JobContext, decision: ChargerDecision, calls: list[Call], facts: str = "") -> None:
        assert ctx.run is not None
        amps = decision.target_current_a
        if amps is not None and not (0 <= amps <= self.limits.max_current_a):
            raise RunRefused(
                f"A current of {amps} A is outside 0…{self.limits.max_current_a} A; not touching the charger"
            )
        ha = self.c.extras["ha"]
        done: list[Call] = []
        for call in calls:
            if call["service"] == "notify":
                result = await send_mobile(self.c, str(call["message"]), dry_run=False)
                done.append({**call, "service": result["service"] or "notify", "ok": result["ok"], **_extra(result)})
                continue
            domain, service = str(call["service"]).split(".", 1)
            data = {k: v for k, v in call.items() if k not in ("service",)}
            try:
                await ha.call_service(domain, service, data)
                done.append({**call, "ok": True})
            except Exception as exc:
                done.append({**call, "ok": False, "error": str(exc)})
                log.error("Charger call %s failed: %s", call["service"], exc)
        ctx.run.artifact("charger_calls", done)
        limit_set = any(c["ok"] for c in done if c.get("service") == "number.set_value")
        if limit_set and decision.target_current_a is not None:
            self.last_applied = {"target_a": decision.target_current_a, "at": self.c.clock.now()}
        result = await self._read_back(decision)
        ctx.run.artifact("charger_readback", result)
        failed = [c for c in done if c["ok"] is False and not str(c["service"]).startswith("notify")]
        notify_failed = any(c["ok"] is False and str(c["service"]).startswith("notify") for c in done)
        if failed or not result["agree"]:
            ctx.run.outcome = "error"
            ctx.run.error = "; ".join(str(c.get("error", "")) for c in failed) or "the charger doesn't show the target"
        ctx.run.summary = (
            f"Did {describe(decision)}"
            + (f" · {facts}" if facts else "")
            + ("; the notification failed" if notify_failed else "")
        )

    async def _read_back(self, decision: ChargerDecision, attempts: int = 10, every_s: float = 0.5) -> dict[str, Any]:
        e = self.c.settings.current.charger.entities
        result: dict[str, Any] = {}
        for attempt in range(attempts):
            await self._reread([e.current_limit_number, e.charging_state_sensor, e.target_soc_number])
            result = compare(decision, self.observed())
            if result["agree"] or attempt == attempts - 1:
                break
            await self.c.clock.wait(asyncio.Event(), every_s)
        return result

    def next_compare(self, after: datetime) -> datetime | None:
        exp = self.expect
        if exp is None or not self.compare_job_active():
            return None
        at: datetime = exp["at"]
        return at if at > after else after + timedelta(seconds=1)

    async def compare_job(self, ctx: JobContext) -> None:
        """Dry run: did the automation do what EMHASS Lens decided? Polls the charger for a little while, because
        the automation runs a few seconds after us and the charger answers over Modbus."""
        assert ctx.run is not None
        now = self.c.clock.now()
        unexpected = ctx.params.get("unexpected")
        if unexpected:
            last = f" (last decision: {describe(self.last_decision)})" if self.last_decision else ""
            self.last_compare = {"at": iso(now), "agree": False, "fields": [], "unexpected": unexpected}
            ctx.run.artifact("charger_comparison", self.last_compare)
            ctx.run.outcome = "mismatch"
            ctx.run.summary = (
                f"The automation set the current limit from {unexpected['from']} A to {unexpected['to']} A; "
                f"EMHASS Lens had decided nothing{last}"
            )
            return
        exp = self.expect
        if exp is None:
            ctx.run.outcome, ctx.run.summary = "noop", "No pending decision to compare"
            return
        decision: ChargerDecision = exp["decision"]
        e = self.c.settings.current.charger.entities
        attempts = max(1, int(exp["window_s"]) // 2)
        result: dict[str, Any] = {}
        attempt = 0
        for attempt in range(attempts):
            await self._reread([e.current_limit_number, e.charging_state_sensor, e.target_soc_number])
            result = compare(decision, self.observed())
            if result["agree"] or attempt == attempts - 1:
                break
            await self.c.clock.wait(asyncio.Event(), 2.0)
        self.expect = None
        self.c.scheduler.retime("charger.compare")
        run_id = exp["decision_run_id"]
        self.last_compare = {"at": iso(now), **result, "decision_run_id": run_id, "attempts": attempt + 1}
        ctx.run.artifact("charger_comparison", self.last_compare)
        ctx.run.outcome = "ok" if result["agree"] else "mismatch"
        if result["agree"]:
            ctx.run.summary = f"Decision #{run_id}: the automation did the same"
        else:
            differ = [
                f"{f['field']}: decided {f['decided']}, automation set {f['observed']}"
                for f in result["fields"]
                if not f["same"]
            ]
            ctx.run.summary = f"Decision #{run_id}: differs — " + "; ".join(differ)

    # --- listeners --------------------------------------------------------------------------------------------------
    async def on_deferrable_state(self, entity_id: str, state: dict[str, Any] | None) -> None:
        """EMHASS's EV power sensor changed (the automation's state trigger)."""
        if not self.active() or state is None:
            return
        stamp = str(state.get("last_updated") or "")
        if stamp == self.last_deferrable_seen:
            return  # a reconnect or re-watch replayed the same state
        self.last_deferrable_seen = stamp
        slot = iso(slot_floor(self.c.clock.now()))
        if self.last_emhass_slot == slot and self.last and self.last["inputs"].get("p_deferrable0_w") == num(state):
            return  # the decision right after the publish already used this value
        self.ask_emhass_decision(num(state))

    def ask_emhass_decision(self, ev_power_w: float | None, **params: Any) -> None:
        """Decide on a new EV power from EMHASS, once per slot and value. The news comes twice around each publish:
        the publish asks right after it, and EMHASS updating its EV power sensor fires a state change (sometimes
        twice, with new timestamps), in either order; whichever comes second must not decide again."""
        key = (iso(slot_floor(self.c.clock.now())), None if ev_power_w is None else round(ev_power_w))
        if key == self.emhass_asked:
            return
        self.emhass_asked = key
        self.c.scheduler.run_now("charger.decide", {"trigger": "emhass_update", **params})

    async def on_soc_state(self, entity_id: str, state: dict[str, Any] | None) -> None:
        """Start (or reset) the target-SoC clock when HA's own trigger would."""
        if not self.active():
            return
        inputs, _ = await self.inputs(self.c.clock.now())
        self._track(inputs, self.c.clock.now())

    async def on_limit_state(self, entity_id: str, state: dict[str, Any] | None) -> None:
        """Dry run: the current limit changed although EMHASS Lens had decided nothing, so the automation acted."""
        if self.mode != "dry_run" or state is None:
            return
        now_value = num(state)
        previous = self._last_limit
        self._last_limit = now_value
        if previous is None or now_value is None or abs(previous - now_value) < 0.5:
            return
        if self.expect is not None:
            return  # a comparison is already pending for this
        last_at = parse_iso(self.last["at"]) if self.last else None
        if last_at is not None and self.c.clock.now() - last_at < timedelta(seconds=self.limits.compare_window_s):
            return  # we just decided; the compare will judge it
        self.c.scheduler.run_now(
            "charger.compare", {"unexpected": {"from": previous, "to": now_value, "at": iso(self.c.clock.now())}}
        )

    # --- status -------------------------------------------------------------------------------------------------------
    async def agreement(self, hours: int = 24) -> dict[str, Any]:
        since = iso(self.c.clock.now() - timedelta(hours=hours))
        rows = await self.c.runs_db.aquery(
            "SELECT outcome, COUNT(*) AS n FROM run WHERE job = 'charger.compare' AND started_at >= ? "
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

    # --- the charge-mode helper (the automation's and the App's shared control) ------------------------
    def charge_mode_info(self) -> dict[str, Any] | None:
        """The helper's current option and its options, from the watched state; None without a helper."""
        e = self.c.settings.current.charger.entities
        if not e.charge_mode_select:
            return None
        state = self._state(e.charge_mode_select)
        options = list(((state or {}).get("attributes") or {}).get("options") or [])
        if not options:
            options = ["Manual", e.emhass_option, e.solar_option]
        current = (state or {}).get("state")
        return {
            "entity": e.charge_mode_select,
            "current": str(current) if current not in (None, "unknown", "unavailable") else None,
            "options": options,
            "emhass_option": e.emhass_option,
            "solar_option": e.solar_option,
        }

    async def set_charge_mode(self, option: str, actor: str) -> None:
        """Set the helper through Home Assistant, like a dashboard would; the helper stays the source of truth."""
        info = self.charge_mode_info()
        if info is None:
            raise ValueError("No charge mode helper is set (Settings → EV charger control → Entities)")
        if option not in info["options"]:
            raise ValueError(f"{option!r} is not one of the helper's options ({', '.join(info['options'])})")
        await self.c.extras["ha"].call_service(
            "input_select", "select_option", {"entity_id": info["entity"], "option": option}
        )
        log.info("Charge mode set to %s by %s", option, actor)
        if self.mode != "off":  # let the new mode take effect at once (dry run records, live acts)
            self.c.scheduler.run_now("charger.decide", {"trigger": "manual"})

    # --- PV reserved for Excess Solar (what the MPC payload leaves out of the PV forecast) ------------------
    async def refresh_load_profile(self) -> None:
        """Cache EMHASS's house load forecast (P_Load of the newest stored plan) for the reservation."""
        if not self.c.settings.current.charger.pv_reserve.enabled:
            return
        plans = await self.c.extras["emhass"].plans(1)
        if not plans:
            self._load_profile, self._profile_plan = {}, None
            return
        plan = plans[0]
        if plan["generated_at"] == self._profile_plan:
            return
        self._load_profile = load_by_slot(plan["plan"])
        self._profile_plan = plan["generated_at"]

    def pv_reserve(self, now: datetime, pv: PvForecast | None) -> EvReserve | None:
        """The PV the car takes from excess solar per slot, from the watched states and the cached load profile.
        None when the feature is off; an inactive reserve says why nothing is reserved."""
        cfg = self.c.settings.current.charger.pv_reserve
        if not cfg.enabled:
            return None
        e = self.c.settings.current.charger.entities
        soc = number(self._state(e.car_soc_sensor), 0.0)
        target = num(self._state(e.target_soc_number))
        why = blocker(
            text(self._state(e.charge_mode_select)),
            e.solar_option,
            integer(self._state(e.charging_state_sensor), -1),
            soc,
            target,
        )
        if why:
            return inactive(why, soc, target)
        if pv is None:
            return inactive("no PV forecast", soc, target)
        if not self._load_profile:
            return inactive("no stored plan yet to tell the house load from", soc, target)
        starts = sorted(start for start in pv.watts if start >= slot_floor(now))
        return plan_reserve(
            starts=starts,
            pv_w=[pv.watts[start] for start in starts],
            load_w=house_load_profile(self._load_profile, starts),
            soc=soc,
            target_soc=target,
            solar_limit_a=integer(self._state(e.max_solar_current_number), 16),
            limits=self.limits,
            capacity_kwh=cfg.car_battery_kwh,
        )

    async def status(self) -> dict[str, Any]:
        await self.refresh_load_profile()
        reserve = self.pv_reserve(self.c.clock.now(), self.c.extras["pv"].current())
        return {
            "drift": self.drift_status(),
            "mode": self.mode,
            "charge_mode": self.charge_mode_info(),
            "pv_reserve": reserve.summary() if reserve is not None else None,
            "last": self.last,
            "last_compare": self.last_compare,
            "last_tick": self.last_tick,
            "soc": self.soc.as_dict(self.limits.soc_for_s),
            "preconditions": self.preconditions() if self.mode == "live" else None,
            "agreement_24h": await self.agreement(24),
            "agreement_7d": await self.agreement(24 * 7),
        }


def _extra(result: dict[str, Any]) -> dict[str, Any]:
    return {k: result[k] for k in ("error", "skipped") if k in result}
