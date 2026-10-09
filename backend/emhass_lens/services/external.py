"""Hold and resume around a market session (mFRR through Qilowatt).

While a Home Assistant entity says that someone else drives the inverter (the Qilowatt automation's session
select is 'buy' or 'sell'), EMHASS Lens builds MPC payloads but doesn't send them, doesn't publish and doesn't
touch the inverter. The moment the session ends it re-applies the plan: one publish, one inverter decision, and
only the registers that differ are written. Optionally MPC runs again afterwards; that re-plan is published but
doesn't touch the inverter in the same slot, so a session end never costs more than one inverter write.
"""

import asyncio
import logging
from datetime import datetime
from typing import TYPE_CHECKING, Any

from emhass_lens.core.clock import iso
from emhass_lens.scheduler.core import JobContext
from emhass_lens.settings.model import Settings

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.external")


class ExternalControlService:
    def __init__(self, c: Container) -> None:
        self.c = c
        self.busy = False
        self.busy_value: str | None = None
        self.busy_since: datetime | None = None
        self.last_hold: dict[str, Any] | None = None
        self.last_resume: dict[str, Any] | None = None

    def enabled(self) -> bool:
        return self.c.settings.current.external_control.enabled and not self.c.boot.safe_mode

    def entities(self) -> set[str]:
        if not self.enabled():
            return set()
        return {self.c.settings.current.external_control.entity} - {""}

    def _market_holds(self) -> bool:
        market = self.c.extras.get("market")
        return market is not None and market.holds_inverter()

    @property
    def holding(self) -> bool:
        """True while someone else owns the inverter: the session entity says so, or the App runs a session itself."""
        return self.busy or self._market_holds()

    def hold_text(self) -> str:
        if not self.busy and self._market_holds():
            return f"the App's own market session, {self.c.extras['market'].session_text()}"
        return f"{self.c.settings.current.external_control.entity} is {self.busy_value!r}"

    def is_busy_state(self, state: dict[str, Any] | None) -> bool:
        if state is None:
            return False
        values = {v.lower() for v in self.c.settings.current.external_control.busy_values}
        return str(state.get("state", "")).lower() in values

    # --- listeners ---------------------------------------------------------------------------------------------
    async def on_state(self, entity_id: str, state: dict[str, Any] | None) -> None:
        market = self.c.extras.get("market")
        if market is not None and market.mode == "live":
            return  # the App runs the sessions itself and hands the inverter back on its own
        if not self.enabled():
            if self.busy:
                await self._clear("the hold is turned off")
            return
        busy = self.is_busy_state(state)
        if busy == self.busy:
            if busy and state is not None:
                self.busy_value = str(state.get("state"))  # e.g. buy -> sell: still held
            return
        now = self.c.clock.now()
        if busy:
            self.busy, self.busy_value, self.busy_since = True, str((state or {}).get("state")), now
            log.info("Hold: %s; MPC runs aren't sent and the inverter isn't touched until it ends", self.hold_text())
            self.c.bus.publish("hold.started", {"entity": entity_id, "value": self.busy_value, "since": iso(now)})
        else:
            ended = {"entity": entity_id, "value": self.busy_value, "since": iso(self.busy_since), "until": iso(now)}
            self.busy, self.last_hold = False, ended
            held_s = int((now - self.busy_since).total_seconds()) if self.busy_since else 0
            log.info("Hold ended after %d s (%s is now %r); resuming", held_s, entity_id, (state or {}).get("state"))
            self.c.bus.publish("hold.ended", ended)
            self.c.scheduler.run_now("external.resume", {"hold": ended})
        await self._refresh_outputs()

    async def on_settings(self, old: Settings, new: Settings, paths: list[str]) -> None:
        if not self.enabled() and self.busy:
            await self._clear("the hold is turned off")

    async def _clear(self, why: str) -> None:
        log.info("Hold cleared: %s", why)
        self.busy, self.busy_value = False, None
        await self._refresh_outputs()

    async def _refresh_outputs(self) -> None:
        outputs = self.c.extras.get("outputs")
        if outputs is not None:
            try:
                await outputs.refresh()
            except Exception as exc:
                log.warning("Refreshing the MQTT entities failed: %s", exc)

    # --- the resume job --------------------------------------------------------------------------------------
    def _enable_on(self) -> bool:
        entity = self.c.settings.current.inverter.entities.enable_boolean
        state = self.c.extras["ha"].state(entity) if entity else None
        return bool(state and state.get("state") == "on")

    async def resume(self, ctx: JobContext) -> None:
        """Re-apply the plan after a session: publish (which chains the inverter decision), optionally re-plan."""
        assert ctx.run is not None
        settings = self.c.settings.current
        external = settings.external_control
        inverter, publish, mpc = self.c.extras["inverter"], self.c.extras["publish"], self.c.extras["mpc"]
        started = self.c.clock.now()
        steps: list[dict[str, Any]] = []

        def step(what: str, result: str) -> None:
            steps.append({"what": what, "result": result, "at": iso(self.c.clock.now())})

        def finish(outcome: str, summary: str) -> None:
            assert ctx.run is not None
            ctx.run.artifact("resume", {"hold": ctx.params.get("hold"), "steps": steps})
            ctx.run.outcome, ctx.run.summary = outcome, summary
            self.last_resume = {"at": iso(started), "outcome": outcome, "summary": summary, "run_id": ctx.run.id}

        if self.busy:
            return finish("noop", "Not resuming: a session is active again")

        if ctx.params.get("skip_apply"):  # the market controller already handed the inverter back; only re-plan
            step("re-apply", "done by the market controller")
            if not (external.replan and mpc.mode == "live"):
                return finish("noop", "Nothing to do: the plan was re-applied and no re-plan is wanted")
            await self.c.clock.wait(asyncio.Event(), external.resume_delay_s)
            await self.c.scheduler.run_now("emhass.mpc", {"reason": "resume"})
            await self.c.scheduler.run_now("emhass.publish", {"reason": "resume", "chain_inverter": False})
            step("re-plan", "ran MPC with the battery state after the session and published it")
            local = started.astimezone(self.c.extras["prices"].tz)
            return finish("ok", f"Resumed {local:%H:%M}: re-planned after the session")

        if inverter.active():
            enable = settings.inverter.entities.enable_boolean
            waited = 0
            while not self._enable_on() and waited < external.handback_wait_s:
                await self.c.clock.wait(asyncio.Event(), 1.0)
                waited += 1
                if self.busy:
                    return finish("noop", "Not resuming: a session started again while waiting for the hand-back")
            if not self._enable_on():
                step("hand-back", f"{enable} is still off after {external.handback_wait_s} s")
                return finish("noop", f"Hand-back not seen: {enable} is still off after {external.handback_wait_s} s")
            step("hand-back", f"{enable} is on" + (f" after {waited} s" if waited else ""))

        if publish.active():
            await self.c.scheduler.run_now("emhass.publish", {"reason": "resume"})
            step("re-apply", "published the stored plan; the inverter decision followed")
        elif inverter.active():
            await self.c.scheduler.run_now("inverter.decide", {"reason": "resume"})
            step("re-apply", "decided the inverter from the stored plan (publish is not active)")
        else:
            step("re-apply", "nothing to re-apply: publish and inverter control are off")

        replanned = False
        if external.replan and mpc.mode == "live":
            await self.c.clock.wait(asyncio.Event(), external.resume_delay_s)
            if self.busy:
                return finish("noop", "Re-applied the plan, but a session started again before the re-plan")
            await self.c.scheduler.run_now("emhass.mpc", {"reason": "resume"})
            await self.c.scheduler.run_now("emhass.publish", {"reason": "resume", "chain_inverter": False})
            step(
                "re-plan",
                "ran MPC with the battery state after the session and published it; the inverter keeps "
                "this slot's targets until the next slot",
            )
            replanned = True

        local = started.astimezone(self.c.extras["prices"].tz)
        finish("ok", f"Resumed {local:%H:%M}: re-applied the plan" + (", then re-planned" if replanned else ""))

    def status(self) -> dict[str, Any]:
        s = self.c.settings.current.external_control
        return {
            "enabled": self.enabled(),
            "busy": self.busy,
            "entity": s.entity,
            "value": self.busy_value if self.busy else None,
            "since": iso(self.busy_since) if self.busy else None,
            "last_hold": self.last_hold,
            "last_resume": self.last_resume,
        }
