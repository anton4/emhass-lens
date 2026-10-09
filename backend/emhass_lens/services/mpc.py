"""The quarter-hourly MPC job, and the publish job.

Modes:
- off      the payload is built and checked every quarter (shadow), EMHASS isn't called;
- dry_run  the same, plus every pre-flight check a live run would do (EMHASS reachable, config OK,
           nobody else driving EMHASS);
- live     the payload is sent; the plan is read back and verified. With Auto MPC off, scheduled
           runs stay shadow builds and only manual runs are sent.
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any

from emhass_lens.core.clock import iso, parse_iso
from emhass_lens.core.slots import slot_floor
from emhass_lens.domain.issues import Issue, errors
from emhass_lens.domain.mpc.anchor import anchor_slot, hazard_wait
from emhass_lens.domain.mpc.payload import BuildResult, build
from emhass_lens.domain.mpc.validate import validate
from emhass_lens.runs.recorder import RunRefused
from emhass_lens.scheduler.core import JobContext
from emhass_lens.services.inputs import describe

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.mpc")


@dataclass
class Shadow:
    """The last build of each quarter, kept for parity checks."""

    built_at: datetime
    anchor: datetime
    result: BuildResult
    compat: BuildResult | None
    run_id: int | None


class MpcService:
    def __init__(self, c: Container) -> None:
        self.c = c
        self.last_shadow: Shadow | None = None
        self.last_live_run_id: int | None = None
        self.last_success_at: datetime | None = None

    @property
    def mode(self) -> str:
        return "off" if self.c.boot.safe_mode else self.c.settings.current.emhass.mode

    def legacy_driving(self) -> bool:
        """True while the HACS integration's Auto MPC switch is on."""
        switch = self.c.settings.current.parity.legacy_auto_mpc_switch
        state = self.c.extras["ha"].state(switch) if switch else None
        return bool(state and state.get("state") == "on")

    def driver(self) -> str:
        legacy = self.legacy_driving()
        ours = self.mode == "live" and self.c.settings.current.emhass.mpc.auto
        if legacy and ours:
            return "both"
        if legacy:
            return "legacy"
        return "app" if ours else "none"

    async def run(self, ctx: JobContext) -> None:
        assert ctx.run is not None
        settings = self.c.settings.current
        emhass = self.c.extras["emhass"]
        mode = self.mode
        send = mode == "live" and (settings.emhass.mpc.auto or ctx.trigger == "manual")
        rounding = emhass.method_ts_round()

        now = self.c.clock.now()
        if mode != "off":
            wait = hazard_wait(now, rounding, emhass.version_tuple, settings.emhass.mpc.hazard_guard_s)
            if wait > 0:
                log.info("Waiting %.0f s: too close to a slot boundary for EMHASS %s", wait, emhass.version or "?")
                await asyncio.sleep(wait)
                now = self.c.clock.now()

        inputs = self.c.extras["inputs"].snapshot(now)
        anchor = anchor_slot(now, rounding)
        result = build(inputs, anchor, slot_floor(now), settings)
        issues = validate(result, inputs, settings)
        compat = None
        if settings.parity.enabled:
            compat_inputs = self.c.extras["inputs"].snapshot(now, legacy_compat=True)
            compat = build(compat_inputs, anchor, slot_floor(now), settings)
        self.last_shadow = Shadow(now, anchor, result, compat, ctx.run.id)

        if mode != "off":
            issues += self._preflight(send)

        ctx.run.artifact("inputs", describe(inputs))
        ctx.run.artifact("request", result.payload)
        ctx.run.artifact(
            "explain",
            {
                "anchor": iso(anchor),
                "rounding": rounding,
                "submitted_at": iso(now),
                "derived": result.derived.__dict__,
                "slots": result.explain,
            },
        )
        ctx.run.artifact("validation", [i.as_dict() for i in issues])

        end = result.explain[-1]["start"] if result.explain else None
        horizon = f"{result.horizon} slots from {anchor:%H:%M} UTC" + (f" to {end[11:16]}" if end else "")
        blocking = errors(issues)
        warn_note = (
            f"; {sum(1 for i in issues if i.level == 'warning')} warning(s)"
            if any(i.level == "warning" for i in issues)
            else ""
        )

        if not send:
            why = {"off": "mode Off", "dry_run": "dry run", "live": "Auto MPC is off"}[mode]
            if blocking:
                ctx.run.outcome = "refused" if mode == "dry_run" else "shadow"
                ctx.run.summary = f"Would refuse ({why}): " + "; ".join(i.message for i in blocking)
            else:
                ctx.run.outcome = "dry_run" if mode == "dry_run" else "shadow"
                ctx.run.summary = f"Built {horizon}, not sent ({why}){warn_note}"
            return

        if blocking:
            raise RunRefused("; ".join(i.message for i in blocking))
        await self._send(ctx, result, horizon, warn_note)

    def _preflight(self, send: bool) -> list[Issue]:
        emhass = self.c.extras["emhass"]
        issues: list[Issue] = []
        if emhass.reachable is not True:
            issues.append(
                Issue("error", "emhass_unreachable", f"EMHASS is not reachable ({emhass.last_error or 'unknown'})")
            )
        if emhass.checks and not emhass.config_ok():
            bad = [c.title for c in emhass.checks if c.status == "error"]
            issues.append(
                Issue(
                    "error",
                    "emhass_config",
                    "EMHASS configuration problem: " + ", ".join(bad),
                    hint="See Health → EMHASS configuration.",
                )
            )
        if self.legacy_driving():
            issues.append(
                Issue(
                    "error",
                    "double_driver",
                    "The HACS integration's Auto MPC is still on; only one may drive EMHASS",
                    hint="Use 'Take over' on the Health page.",
                )
            )
        if self.c.extras.get("ml_running"):
            issues.append(Issue("error", "ml_fit_running", "An ML model fit is running in EMHASS"))
        return issues

    async def _send(self, ctx: JobContext, result: BuildResult, horizon: str, warn_note: str) -> None:
        assert ctx.run is not None
        emhass = self.c.extras["emhass"]
        settings = self.c.settings.current
        sent_at = self.c.clock.now()
        async with emhass.action_lock:
            response = await emhass.client.action("naive-mpc-optim", result.payload, settings.emhass.timeouts.mpc)
        ctx.run.artifact(
            "response",
            {
                "http_status": response.http_status,
                "duration_ms": response.duration_ms,
                "error": response.error,
                "error_lines": response.error_lines,
                "body": response.body[:20000],
            },
        )
        if response.error and response.http_status is None:
            ctx.run.outcome, ctx.run.error = ("timeout" if "timed out" in response.error else "error"), response.error
            return
        try:
            last_run = await emhass.client.last_run()
        except Exception as exc:
            last_run = {"status": "unknown", "error_message": str(exc)}
        ctx.run.artifact("emhass_last_run", last_run)
        status = last_run.get("status")
        stamp = parse_iso(str(last_run.get("timestamp"))) if last_run.get("timestamp") else None
        fresh = stamp is not None and stamp >= sent_at.replace(microsecond=0)
        if response.error or status == "error":
            ctx.run.outcome = "error"
            ctx.run.error = response.error or last_run.get("error_message") or "EMHASS reported an error"
            return
        if status == "infeasible":
            ctx.run.outcome = "infeasible"
            ctx.run.summary = f"EMHASS found no feasible plan for {horizon}; the previous plan stays in place"
            return
        if not fresh:
            ctx.run.outcome = "error"
            ctx.run.error = (
                f"EMHASS answered, but its last run ({last_run.get('timestamp')}) is older than this request"
            )
            return
        await emhass.watch_plan(ctx, driver="app", run_id=ctx.run.id)
        self.last_live_run_id = ctx.run.id
        self.last_success_at = self.c.clock.now()
        ctx.run.outcome = "ok"
        ctx.run.summary = f"Planned {horizon} in {response.duration_ms / 1000:.1f} s{warn_note}"
        self.c.bus.publish("plan.updated", {"run_id": ctx.run.id})

    def status(self) -> dict[str, Any]:
        shadow = self.last_shadow
        return {
            "mode": self.mode,
            "auto": self.c.settings.current.emhass.mpc.auto,
            "driver": self.driver(),
            "legacy_driving": self.legacy_driving(),
            "last_success_at": iso(self.last_success_at),
            "last_build": None
            if shadow is None
            else {
                "built_at": iso(shadow.built_at),
                "anchor": iso(shadow.anchor),
                "horizon": shadow.result.horizon,
                "run_id": shadow.run_id,
            },
        }
