"""The market session watchdog: the App's version of the HA automation "Qilowatt: Session Watchdog".

A safety net next to the market controller that shares none of its decision logic (`domain/market_watchdog.py`,
not `domain/market.py`) and runs as its own job, so a bug, a stuck run or a refusal in the controller can't
disable it. Every minute it checks the cached states without recording a run; when something is due it runs once
more, recorded, re-reads the entities over REST and:

- Live:   ends a stale session (the source gone for `stale_after_s`) the way a session end does: the select back to
          none, the EMHASS switch on, the inverter handed back to the plan (the safe state only when there is no
          fresh plan, and only the registers that differ are written), plus a phone message. It reports a long
          session and the EMHASS switch left off with the inverter forced, once each.
- Shadow: the HA automations run the sessions: records what it would clear and report, writes and sends nothing.
- Off:    nothing (market control off, or the watchdog turned off in its settings).
"""

import asyncio
import logging
from dataclasses import asdict
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from emhass_lens.core.clock import iso
from emhass_lens.domain.market_watchdog import Finding, WatchdogInputs, check
from emhass_lens.runs.recorder import RunRefused
from emhass_lens.scheduler.core import JobContext
from emhass_lens.services.ha_values import changed_at, text
from emhass_lens.services.notify import send_mobile

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.market.watchdog")

JOB_ID = "market.watchdog"
LOCK_WAIT_S = 120.0  # how long to wait for a market run in progress before acting anyway
STALE_NOTIFY_EVERY = timedelta(minutes=5)  # while a stale session can't be cleared: the automation's cadence
FORGET_AFTER = timedelta(days=1)
TITLE = "Qilowatt watchdog"


class MarketWatchdog:
    def __init__(self, c: Container) -> None:
        self.c = c
        self.findings: list[Finding] = []
        self.checked_at: datetime | None = None
        self.created_at = c.clock.now()
        self.last_action: dict[str, Any] | None = None
        self._handled: dict[str, datetime] = {}  # episode → when it was last acted on or reported

    @property
    def mode(self) -> str:
        """The market control's mode while the watchdog is on, else off."""
        return self.c.extras["market"].mode if self.c.settings.current.market.watchdog.enabled else "off"

    def _state(self, entity_id: str) -> dict[str, Any] | None:
        return self.c.extras["ha"].state(entity_id) if entity_id else None

    def inputs(self) -> WatchdogInputs:
        me, inv = self.c.settings.current.market.entities, self.c.settings.current.inverter.entities
        session = self.c.extras["market"].session if self.mode == "live" else None
        select, source = self._state(me.session_select), self._state(me.source_sensor)
        enable = self._state(inv.enable_boolean)
        return WatchdogInputs(
            app_session=session.direction if session else None,
            app_session_since=session.started_at if session else None,
            select=text(select),
            select_changed=changed_at(select),
            source=text(source),
            source_changed=changed_at(source),
            enable=text(enable),
            enable_changed=changed_at(enable),
            passive_state=text(self._state(inv.state_select)),
        )

    def _check(self, now: datetime) -> tuple[WatchdogInputs, list[Finding]]:
        market = self.c.settings.current.market
        inputs = self.inputs()
        return inputs, check(inputs, market.watchdog, market.thresholds.sources, now, shadow=self.mode == "shadow")

    def _due(self, finding: Finding) -> bool:
        """A stale session in Live is acted on every minute until it's cleared; anything else once per episode."""
        return (finding.kind == "stale" and self.mode == "live") or finding.episode not in self._handled

    # --- the job ------------------------------------------------------------------------------------------------
    async def job(self, ctx: JobContext) -> None:
        if ctx.run is None:  # the minute probe, not recorded
            if self.mode == "off" or not self.c.extras["ha"].connected:
                self.findings = []
                return
            now = self.c.clock.now()
            _, self.findings = self._check(now)
            self.checked_at = now
            if any(self._due(f) for f in self.findings):
                self.c.scheduler.run_now(JOB_ID, {"promoted": True}, trigger="event")
            return
        if self.mode == "off":
            ctx.run.outcome, ctx.run.summary = "noop", "The session watchdog is off (or market control is)"
            return
        if not self.c.extras["ha"].connected:
            raise RunRefused("Not connected to Home Assistant")
        if self.mode != "live":
            await self._run(ctx, waited_out=False)
            return
        lock = self.c.extras["market"].act_lock
        try:
            async with asyncio.timeout(LOCK_WAIT_S):
                await lock.acquire()
        except TimeoutError:
            log.warning("A market run held the controller for %d s; the watchdog acts anyway", LOCK_WAIT_S)
            await self._run(ctx, waited_out=True)
            return
        try:
            await self._run(ctx, waited_out=False)
        finally:
            lock.release()

    async def _reread(self, *, inverter: bool = True) -> None:
        """The WebSocket cache can lag: re-read what the checks look at over REST."""
        ha = self.c.extras["ha"]
        me = self.c.settings.current.market.entities
        for entity_id in (me.session_select, me.source_sensor):
            if entity_id:
                state = await ha.get_state(entity_id)
                if state is None:
                    ha.states.pop(entity_id, None)
                else:
                    ha.states[entity_id] = state
        if inverter:
            await self.c.extras["sofar"].refresh()  # the EMHASS switch, the state select and the registers

    async def _run(self, ctx: JobContext, *, waited_out: bool) -> None:
        run = ctx.run
        assert run is not None
        await self._reread()
        now = self.c.clock.now()
        inputs, findings = self._check(now)
        self.findings, self.checked_at = findings, now
        self._handled = {k: t for k, t in self._handled.items() if now - t < FORGET_AFTER}
        live = self.mode == "live"
        run.artifact(
            "watchdog",
            {
                "mode": self.mode,
                "inputs": {k: iso(v) if isinstance(v, datetime) else v for k, v in asdict(inputs).items()},
                "findings": [f.as_dict() for f in findings],
                "settings": self.c.settings.current.market.watchdog.model_dump(),
            },
        )
        if not findings:
            run.outcome, run.summary = "noop", "All clear (the situation resolved before the re-check)"
            return

        parts: list[str] = []
        notes: list[dict[str, Any]] = []
        stale = next((f for f in findings if f.kind == "stale"), None)
        if stale is not None and live:
            parts.append(await self._clear(ctx, stale, now, waited_out, notes))
            await self._reread(inverter=False)  # the hand-back refreshed the inverter's entities already
            _, self.findings = self._check(now)  # what's left after the clear, for Health and the Market page
        elif stale is not None and self._due(stale):
            run.outcome = "dry_run"
            parts.append(f"Would clear a stale {stale.message}")
            notes.append(await self._send(f"{TITLE}: would clear a stale {stale.message}.", dry_run=True))
            self._handled[stale.episode] = now
        for f in findings:
            if f.kind == "stale" or not self._due(f):
                continue
            if f.kind == "long_session" and stale is not None and live:
                continue  # that session was just cleared
            parts.append(f"Reported: {f.message}")
            notes.append(await self._send(_report(f), dry_run=not live))
            self._handled[f.episode] = now
        if not parts:
            run.outcome, run.summary = "noop", "Already reported: " + "; ".join(f.message for f in findings)
            return
        if run.outcome is None:
            run.outcome = "ok" if live else "dry_run"
        run.summary = " · ".join(parts)
        if notes:
            run.artifact("notifications", notes)
        self.last_action = {"at": iso(now), "run_id": run.id, "outcome": run.outcome, "summary": run.summary}

    async def _clear(
        self, ctx: JobContext, stale: Finding, now: datetime, waited_out: bool, notes: list[dict[str, Any]]
    ) -> str:
        run = ctx.run
        assert run is not None
        market = self.c.extras["market"]
        lead = f"Watchdog: cleared a stale {stale.message}."
        if waited_out:
            lead += f" A market run held the controller for over {int(LOCK_WAIT_S)} s."
        log.warning("Session watchdog: clearing a stale %s", stale.message)
        handed = await market.end_and_hand_back(ctx, reason="watchdog", message=lead, now=now, owner="watchdog")
        summary = str(run.summary or lead)
        last = self._handled.get(stale.episode)
        if last is None or now - last >= STALE_NOTIFY_EVERY:
            result = (
                "Inverter handed back to the plan"
                if handed
                else "Inverter reset to self-use"
                if "set the safe state" in summary
                else "Registers were already clean, no EEPROM write"
            )
            failed = f" Some calls failed: {run.error}." if run.outcome == "error" else ""
            notes.append(
                await self._send(
                    f"{TITLE}: cleared a stale {stale.message}. {result}, EMHASS re-enabled.{failed} "
                    "Check the Market page in EMHASS Lens.",
                    dry_run=False,
                )
            )
            self._handled[stale.episode] = now
        return summary

    async def _send(self, message: str, *, dry_run: bool) -> dict[str, Any]:
        return await send_mobile(self.c, message, title=TITLE, dry_run=dry_run)

    # --- status -------------------------------------------------------------------------------------------------
    def not_checking(self, now: datetime) -> str | None:
        """Why the watchdog isn't watching while market control is live, or None."""
        if not self.c.settings.current.market.watchdog.enabled:
            return "it is turned off in Settings → Qilowatt market control → Session watchdog"
        job = self.c.scheduler.jobs.get(JOB_ID)
        if job is not None and job.paused:
            return "its job is paused under Runs → Jobs"
        last = self.checked_at or self.created_at
        if self.c.extras["ha"].connected and now - last > timedelta(minutes=3):
            return f"its last check was {int((now - last).total_seconds() // 60)} min ago"
        return None

    def status(self) -> dict[str, Any]:
        w = self.c.settings.current.market.watchdog
        return {
            "enabled": w.enabled,
            "mode": self.mode,
            "stale_after_s": w.stale_after_s,
            "long_session_s": w.long_session_s,
            "emhass_off_s": w.emhass_off_s,
            "checked_at": iso(self.checked_at),
            "findings": [f.as_dict() for f in self.findings],
            "last_action": self.last_action,
        }


def _report(f: Finding) -> str:
    if f.kind == "long_session":
        return f"{TITLE}: {f.message}. Not intervening, just make sure this is expected."
    return f"{TITLE}: {f.message}. Someone needs to check this."
