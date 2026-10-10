"""Catch up the current slot when Home Assistant comes back (a restart, a reboot of the host, a lost connection).

While Home Assistant is away the quarter-hour publish fails and the inverter and EV charger decisions are refused
("not connected"); the scheduler doesn't retry a slot, so without this the inverter would keep the previous slot's
settings until the next quarter. A Home Assistant restart also drops EMHASS's sensor.p_* states, which publish-data
sets through the REST API.

On every (re)connect, in live mode while EMHASS Lens drives EMHASS: publish again when this slot's publish didn't
happen or the sensors are gone, then decide the inverter (and the charger) for this slot. Right after Home Assistant
starts its integrations may still be loading, so a refusal for an entity that isn't there yet is retried for a while.
"""

import asyncio
import logging
from datetime import timedelta
from typing import TYPE_CHECKING

from emhass_lens.core.slots import slot_floor
from emhass_lens.services.inverter import PLAN_SENSORS, transient_block

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.catchup")

UNSET = {None, "unknown", "unavailable", ""}


class CatchUpService:
    retry_s: float = 20.0
    attempts: int = 15  # 5 minutes at 20 s

    def __init__(self, c: Container) -> None:
        self.c = c
        self._task: asyncio.Task[None] | None = None

    def wanted(self) -> bool:
        mpc = self.c.extras["mpc"]
        if self.c.boot.safe_mode or mpc.mode != "live" or mpc.driver() != "app":
            return False
        external = self.c.extras.get("external")
        return not (external is not None and external.holding)

    async def on_connect(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
        if self.wanted():
            self._task = asyncio.create_task(self.run(), name="catchup")

    def _published_this_slot(self) -> bool:
        published = self.c.extras["publish"].last_published_at
        return published is not None and slot_floor(published) >= slot_floor(self.c.clock.now())

    def _publish_needed(self) -> bool:
        if not self._published_this_slot():
            return True
        state = self.c.extras["ha"].state(PLAN_SENSORS["p_batt"])
        return state is None or state.get("state") in UNSET  # a Home Assistant restart drops EMHASS's sensors

    def _inverter_needed(self) -> bool:
        inverter = self.c.extras.get("inverter")
        return inverter is not None and inverter.mode == "live" and not inverter.applied_this_slot()

    def _charger_needed(self) -> bool:
        charger = self.c.extras.get("charger")
        return charger is not None and charger.mode == "live"

    async def run(self) -> None:
        """Publish and decide for the current slot until it's done, a refusal that won't go away, or the slot ends."""
        slot = slot_floor(self.c.clock.now())
        publish, inverter, charger = self._publish_needed(), self._inverter_needed(), self._charger_needed()
        if not (publish or inverter or charger):
            return
        local = slot.astimezone(self.c.extras["prices"].tz)
        log.info("Home Assistant is back: catching up the %s slot", f"{local:%H:%M}")
        charger_done = not charger
        for attempt in range(self.attempts):
            if attempt:
                await asyncio.sleep(self.retry_s)
            now = self.c.clock.now()
            if slot_floor(now) != slot or now >= slot + timedelta(minutes=15) or not self.wanted():
                return  # the next slot's own publish and decisions take over
            if publish:
                await self.c.scheduler.run_now(
                    "emhass.publish", {"catch_up": True, "chain_inverter": False, "chain_charger": False}, "event"
                )
                if not self._published_this_slot():
                    continue  # EMHASS or Home Assistant isn't ready yet
                publish = False
            if not charger_done:
                await self.c.scheduler.run_now("charger.decide", {"trigger": "catch_up"}, "event")
                charger_done = True
            if not self._inverter_needed():
                return
            await self.c.scheduler.run_now("inverter.decide", {"catch_up": True}, "event")
            if not self._inverter_needed():
                return
            why = self.c.extras["inverter"].refusal_this_slot()
            if not transient_block(why):
                log.info("Catch-up: the inverter wasn't set for this slot (%s)", why or "no decision")
                return
        log.warning(
            "Catch-up gave up after %d attempts: Home Assistant's entities didn't come back in time", self.attempts
        )

    def stop(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
