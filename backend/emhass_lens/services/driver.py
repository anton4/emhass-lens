"""Who drives EMHASS: hand over from the HACS integration to EMHASS Lens and back, in one step each."""

import asyncio
import logging
from typing import TYPE_CHECKING, Any

from emhass_lens.runs.recorder import RunRefused

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.driver")


async def _set_legacy(c: Container, on: bool) -> str | None:
    """Turn the integration's Auto MPC switch on/off and wait until HA shows it. Returns its final state."""
    ha = c.extras["ha"]
    switch = c.settings.current.parity.legacy_auto_mpc_switch
    state = await ha.get_state(switch)
    if state is None:
        return None
    await ha.call_service("switch", "turn_on" if on else "turn_off", {"entity_id": switch})
    for _ in range(25):
        state = await ha.get_state(switch)
        if state and state.get("state") == ("on" if on else "off"):
            break
        await asyncio.sleep(0.2)
    if state is not None:
        ha.states[switch] = state
    return (state or {}).get("state")


async def take_over(c: Container, actor: str, base_revision: int | None) -> dict[str, Any]:
    result: dict[str, Any] = {}
    async with c.recorder.start("driver.take_over", trigger="manual", mode="live") as run:
        result = {"run_id": run.id, "ok": False}
        switch = c.settings.current.parity.legacy_auto_mpc_switch
        state = await _set_legacy(c, False)
        if state not in (None, "off"):
            raise RunRefused(f"{switch} is still {state!r}; EMHASS Lens didn't take over")
        saved = await c.settings.save(
            {"emhass": {"mode": "live", "mpc": {"auto": True}}},
            base_revision=base_revision,
            actor=actor,
            comment="Take over from the HACS integration",
        )
        run.summary = (
            f"{switch} is {state or 'not present'}; EMHASS Lens is live from the next quarter "
            f"(revision {saved.revision})"
        )
        log.info("Took over driving EMHASS (%s)", actor)
        result = {"run_id": run.id, "ok": True, "revision": saved.revision, "legacy_switch": state}
    if not result.get("ok"):
        result["error"] = run.summary or run.error
    return result


async def hand_back(c: Container, actor: str, base_revision: int | None) -> dict[str, Any]:
    result: dict[str, Any] = {}
    async with c.recorder.start("driver.hand_back", trigger="manual", mode="dry_run") as run:
        result = {"run_id": run.id, "ok": False}
        saved = await c.settings.save(
            {"emhass": {"mode": "dry_run"}},
            base_revision=base_revision,
            actor=actor,
            comment="Hand back to the HACS integration",
        )
        state = await _set_legacy(c, True)
        switch = c.settings.current.parity.legacy_auto_mpc_switch
        run.summary = f"EMHASS Lens is in dry run; {switch} is {state or 'not present'}"
        if state not in ("on",):
            run.outcome = "error"
            run.error = f"{switch} is {state or 'missing'}: nobody drives EMHASS now"
        log.info("Handed EMHASS back to the HACS integration (%s)", actor)
        result = {"run_id": run.id, "ok": state == "on", "revision": saved.revision, "legacy_switch": state}
    if not result.get("ok"):
        result["error"] = run.error or run.summary
    return result
