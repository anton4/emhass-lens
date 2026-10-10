"""When Home Assistant comes back mid-slot: publish again and set the inverter for the slot it missed."""

import asyncio
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from emhass_lens.core.clock import FakeClock
from emhass_lens.services.inverter import transient_block
from tests.test_inverter_service import world as inverter_world  # noqa: F401  (fixture)
from tests.test_phase1 import prime, run_job
from tests.test_phase2 import live_client
from tests.world import World

PLANNED = datetime(2026, 10, 9, 11, 13, 0, tzinfo=UTC)
# Home Assistant came back late in the 14:15 slot: past the grace of the slot's own publish and decision, so the
# scheduler records those as missed instead of running them alongside the catch-up
MISSED = datetime(2026, 10, 9, 11, 21, 5, tzinfo=UTC)
MODE = "select.sofar_charger_use_mode"
P_BATT = "sensor.p_batt_forecast"


@pytest.fixture
def world(inverter_world: World) -> World:  # noqa: F811
    return inverter_world


def container(client: TestClient):
    return client.app.state.container  # type: ignore[attr-defined]


def runs(client: TestClient, job: str) -> list[dict]:
    return client.get("/api/runs", params={"job": job}).json()


def reconnect(client: TestClient) -> None:
    """What the WebSocket client does once Home Assistant answers again: connected, then the connect listeners."""
    c = container(client)
    c.extras["ha"].connected = True

    async def go() -> None:
        catchup = c.extras["catchup"]
        await catchup.on_connect()
        if catchup._task is not None:
            await asyncio.wait_for(catchup._task, 10)

    client.portal.call(go)  # type: ignore[union-attr]


def live_inverter(tmp_path: Path, world: World, clock: FakeClock) -> TestClient:
    client = live_client(tmp_path, world, clock, inverter={"mode": "live"})
    container(client).extras["catchup"].retry_s = 0.05
    assert run_job(client, "emhass.mpc")["outcome"] == "ok"
    clock.set(MISSED)
    return client


def miss_the_slot(client: TestClient, world: World) -> None:
    """Home Assistant goes down: the slot's decision is refused, and its restart drops EMHASS's sensors."""
    ha = container(client).extras["ha"]
    ha.connected = False
    refused = run_job(client, "inverter.decide")
    assert refused["outcome"] == "refused" and "Not connected to Home Assistant" in refused["summary"]
    del world.ha_states[P_BATT]
    ha.states.pop(P_BATT, None)


def test_the_missed_slot_is_published_and_set_when_home_assistant_is_back(tmp_path: Path, world: World) -> None:
    client = live_inverter(tmp_path, world, FakeClock(PLANNED))
    try:
        miss_the_slot(client, world)
        writes_before = len([s for s in world.ha_services if s[0] == "number/set_value"])
        reconnect(client)

        [publish] = [r for r in runs(client, "emhass.publish") if r["trigger"] == "event"]
        assert publish["outcome"] == "ok", publish
        decided = runs(client, "inverter.decide")[0]
        assert decided["trigger"] == "event" and decided["outcome"] == "ok", decided
        assert decided["summary"].endswith("(catch-up after Home Assistant came back)")
        assert len([s for s in world.ha_services if s[0] == "number/set_value"]) > writes_before
        decision = client.get(f"/api/runs/{decided['id']}/artifacts/decision").json()
        assert decision["source"].startswith("stored EMHASS plan")  # Home Assistant lost EMHASS's sensors
        grid = decision["decision"]["targets"]["grid_power_w"]
        assert float(world.ha_states["number.sofar_passive_mode_grid_power"]["state"]) == grid

        # EMHASS's publish restored the sensors; another reconnect in the same slot has nothing to do
        world.set_state(P_BATT, -6000)
        prime(client, world)
        count = len(runs(client, "emhass.publish")) + len(runs(client, "inverter.decide"))
        reconnect(client)
        assert len(runs(client, "emhass.publish")) + len(runs(client, "inverter.decide")) == count
    finally:
        client.__exit__(None, None, None)


def test_entities_still_loading_are_waited_for(tmp_path: Path, world: World) -> None:
    client = live_inverter(tmp_path, world, FakeClock(PLANNED))
    container(client).extras["catchup"].retry_s = 0.3
    try:
        miss_the_slot(client, world)

        async def fix_when_blocked() -> None:
            inverter = container(client).extras["inverter"]
            for _ in range(200):
                if transient_block(inverter.refusal_this_slot()) and "unavailable" in str(inverter.refusal_this_slot()):
                    world.set_state(MODE, "Passive Mode")
                    container(client).extras["ha"].states[MODE] = world.ha_states[MODE]
                    return
                await asyncio.sleep(0.02)

        async def go() -> None:
            c = container(client)
            ha = c.extras["ha"]
            # entity loads started by the settings change must not put the old state back afterwards
            await asyncio.gather(*list(ha._background), return_exceptions=True)
            world.set_state(MODE, "unavailable")  # Home Assistant is up, the Sofar integration isn't yet
            ha.states[MODE] = world.ha_states[MODE]
            ha.connected = True
            await c.extras["catchup"].on_connect()
            await asyncio.gather(fix_when_blocked(), asyncio.wait_for(c.extras["catchup"]._task, 10))

        client.portal.call(go)  # type: ignore[union-attr]
        outcomes = [r["outcome"] for r in runs(client, "inverter.decide") if r["trigger"] == "event"]
        assert outcomes == ["ok", "noop"], outcomes  # newest first: blocked while loading, then set
        assert container(client).extras["inverter"].applied_this_slot()
    finally:
        client.__exit__(None, None, None)


def test_nothing_is_caught_up_unless_the_app_drives_emhass(tmp_path: Path, world: World) -> None:
    clock = FakeClock(PLANNED)
    emhass = {"base_url": "http://emhass.test:5000", "mode": "dry_run", "mpc": {"auto": True}}
    client = live_client(tmp_path, world, clock, emhass=emhass, inverter={"mode": "live"})
    try:
        clock.set(MISSED)
        reconnect(client)
        assert container(client).extras["catchup"]._task is None
        assert [r for r in runs(client, "emhass.publish") if r["trigger"] == "event"] == []
    finally:
        client.__exit__(None, None, None)


def test_transient_refusals() -> None:
    assert transient_block("select.sofar_charger_use_mode is 'unavailable', not 'Passive Mode'")
    assert transient_block("select.sofar_charger_use_mode not found")
    assert transient_block("Not connected to Home Assistant; not touching the inverter")
    assert not transient_block("The plan is stale (made never); not touching the inverter")
    assert not transient_block("select.sofar_charger_use_mode is 'Self Use', not 'Passive Mode'")
    assert not transient_block("input_boolean.emhass_automation is 'off' (e.g. an mFRR session holds the inverter)")
    assert not transient_block(None)
