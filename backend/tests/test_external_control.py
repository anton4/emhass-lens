"""Hold and resume around a market session: MPC sends, publishes and inverter writes wait while the session
entity is busy, and the plan is re-applied once (one inverter write at most) when the session ends."""

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from emhass_lens.core.clock import FakeClock
from emhass_lens.services.outputs import state_messages
from tests.test_inverter_service import SOFAR
from tests.test_phase1 import prime, run_job
from tests.test_phase2 import LEGACY_SWITCH, live_client
from tests.world import TZ, World

START = datetime(2026, 10, 9, 11, 13, 0, tzinfo=UTC)
SESSION = "input_select.qilowatt_session_state"
ENABLE = "input_boolean.emhass_automation"
APPLY_BUTTON = "button.sofar_passive_mode_battery_charge_discharge"


@pytest.fixture
def world() -> World:
    w = World()
    w.standard_entities(datetime(2026, 10, 9, tzinfo=TZ))
    w.set_state(LEGACY_SWITCH, "off")
    w.set_state("select.sofar_charger_use_mode", "Passive Mode")
    w.set_state(ENABLE, "on")
    w.set_state("input_select.emhass_passive_state", "Self-use battery or PV")
    for entity, value in SOFAR.items():
        w.set_state(entity, value)
    w.set_state("sensor.p_batt_forecast", -6000)  # the plan for this slot: force charge from the grid
    w.set_state("sensor.p_grid_forecast", 4560)
    w.set_state("sensor.p_pv_forecast", 0)
    w.set_state("sensor.p_pv_curtailment", 0)
    w.set_state(SESSION, "none")
    return w


def client_for(tmp_path: Path, world: World, clock: FakeClock, inverter_mode: str = "dry_run", **hold) -> TestClient:
    external = {"enabled": True, "handback_wait_s": 1, **hold}
    return live_client(tmp_path, world, clock, external_control=external, inverter={"mode": inverter_mode})


def container(client: TestClient):
    return client.app.state.container  # type: ignore[attr-defined]


def set_session(client: TestClient, world: World, value: str | None) -> None:
    """What the WebSocket would deliver when the Qilowatt automation changes its session select."""
    ha = container(client).extras["ha"]
    state = world.set_state(SESSION, value) if value is not None else None
    if value is None:
        world.ha_states.pop(SESSION, None)
    portal = client.portal
    assert portal is not None
    portal.call(ha._set_state, SESSION, state)


def manual_run(client: TestClient, job: str) -> dict:
    """Start a job by hand and return its finished run (manual runs are always recorded)."""
    run_id = client.post(f"/api/jobs/{job}/run").json()["run_id"]
    assert run_id is not None, f"{job} didn't start"
    for _ in range(200):
        run = client.get(f"/api/runs/{run_id}").json()
        if run["outcome"] != "running":
            return run
    raise AssertionError(f"{job} didn't finish")


def wait_for_run(client: TestClient, job: str, after_id: int) -> dict:
    """The newest finished run of `job` with an id above `after_id` (a background run started by a listener)."""
    for _ in range(500):
        runs = client.get("/api/runs", params={"job": job}).json()
        if runs and runs[0]["id"] > after_id and runs[0]["outcome"] != "running":
            return runs[0]
    raise AssertionError(f"no new {job} run")


def newest_id(client: TestClient, job: str) -> int:
    runs = client.get("/api/runs", params={"job": job}).json()
    return runs[0]["id"] if runs else 0


def test_a_session_holds_mpc_publish_and_the_inverter(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock)
    try:
        assert run_job(client, "emhass.mpc")["outcome"] == "ok"  # a plan exists before the session
        set_session(client, world, "sell")
        mpc = client.get("/api/emhass").json()["mpc"]
        assert mpc["held"] is True
        assert mpc["hold"]["value"] == "sell" and mpc["hold"]["enabled"] is True
        assert json.loads(state_messages(container(client))[0].payload)["hold"] == "ON"

        held = manual_run(client, "emhass.mpc")
        assert held["outcome"] == "shadow", held
        assert "held" in held["summary"] and "'sell'" in held["summary"]
        assert len([a for a in world.emhass_actions if a[0] == "naive-mpc-optim"]) == 1  # not sent again

        publish = manual_run(client, "emhass.publish")
        assert publish["outcome"] == "noop" and publish["summary"].startswith("Held")

        decide = manual_run(client, "inverter.decide")
        assert decide["outcome"] == "noop"
        assert "market session holds the inverter" in decide["summary"]
    finally:
        client.__exit__(None, None, None)


def test_the_resume_reapplies_the_plan_with_one_inverter_write(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, inverter_mode="live")
    try:
        assert run_job(client, "emhass.mpc")["outcome"] == "ok"
        # the market session: the automation forces discharge and takes the enable switch
        set_session(client, world, "sell")
        world.set_state(ENABLE, "off")
        world.set_state("input_select.emhass_passive_state", "Force discharge")
        world.set_state("number.sofar_passive_mode_grid_power", -5000)
        prime(client, world)
        actions_before = len(world.emhass_actions)
        services_before = len(world.ha_services)
        decides_before = newest_id(client, "inverter.decide")
        # the session ends: the automation hands the switch back, then clears its session select
        world.set_state(ENABLE, "on")
        prime(client, world)
        set_session(client, world, "none")

        resume = wait_for_run(client, "external.resume", 0)
        assert resume["outcome"] == "ok", resume
        assert resume["summary"].startswith("Resumed 14:13: re-applied the plan")
        assert [a[0] for a in world.emhass_actions[actions_before:]] == ["publish-data"]
        decide = wait_for_run(client, "inverter.decide", decides_before)
        assert decide["trigger"] == "manual" and decide["outcome"] == "ok", decide
        decision = client.get(f"/api/runs/{decide['id']}/artifacts/decision").json()["decision"]
        feedin_changed = decision["feedin_max_w"] != SOFAR["number.sofar_feedin_max_power"]
        services = world.ha_services[services_before:]
        presses = [s[1]["entity_id"] for s in services if s[0] == "button/press"]
        assert presses.count(APPLY_BUTTON) == 1  # one passive-mode write for the whole hand-back
        assert len([s for s in services if s[0] == "number/set_value"]) == 3 + feedin_changed
        assert world.ha_states["number.sofar_passive_mode_grid_power"]["state"] == "5600.0"
        assert client.get("/api/emhass").json()["mpc"]["hold"]["last_resume"]["outcome"] == "ok"
    finally:
        client.__exit__(None, None, None)


def test_a_replan_after_the_resume_does_not_touch_the_inverter_again(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, inverter_mode="live", replan=True, resume_delay_s=0)
    try:
        assert run_job(client, "emhass.mpc")["outcome"] == "ok"
        set_session(client, world, "sell")
        world.set_state("number.sofar_passive_mode_grid_power", -5000)
        prime(client, world)
        actions_before = len(world.emhass_actions)
        services_before = len(world.ha_services)
        decides_before = newest_id(client, "inverter.decide")
        set_session(client, world, "none")

        resume = wait_for_run(client, "external.resume", 0)
        assert resume["outcome"] == "ok", resume
        assert resume["summary"].endswith("re-applied the plan, then re-planned")
        actions = [a[0] for a in world.emhass_actions[actions_before:]]
        assert actions == ["publish-data", "naive-mpc-optim", "publish-data"]
        wait_for_run(client, "inverter.decide", decides_before)
        decides = client.get("/api/runs", params={"job": "inverter.decide"}).json()
        assert len([r for r in decides if r["id"] > decides_before]) == 1  # the second publish didn't chain a decision
        presses = [s[1]["entity_id"] for s in world.ha_services[services_before:] if s[0] == "button/press"]
        assert presses.count(APPLY_BUTTON) == 1
    finally:
        client.__exit__(None, None, None)


def test_no_resume_without_the_hand_back(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock)
    try:
        assert run_job(client, "emhass.mpc")["outcome"] == "ok"
        set_session(client, world, "sell")
        world.set_state(ENABLE, "off")  # the automation keeps the switch
        prime(client, world)
        actions_before = len(world.emhass_actions)
        set_session(client, world, "none")
        resume = wait_for_run(client, "external.resume", 0)
        assert resume["outcome"] == "noop", resume
        assert resume["summary"].startswith("Hand-back not seen")
        assert world.emhass_actions[actions_before:] == []
    finally:
        client.__exit__(None, None, None)


def test_repeated_and_missing_states(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock)
    try:
        set_session(client, world, "sell")
        since = client.get("/api/emhass").json()["mpc"]["hold"]["since"]
        set_session(client, world, "sell")  # a reconnect replays the same state
        assert client.get("/api/emhass").json()["mpc"]["hold"]["since"] == since
        set_session(client, world, "none")
        first = wait_for_run(client, "external.resume", 0)
        set_session(client, world, "sell")
        set_session(client, world, None)  # the entity disappears: not busy any more
        second = wait_for_run(client, "external.resume", first["id"])
        assert second["id"] > first["id"]
        assert len(client.get("/api/runs", params={"job": "external.resume"}).json()) == 2
        assert client.get("/api/emhass").json()["mpc"]["held"] is False
        run_job(client, "health.evaluate")
        keys = {p["key"] for p in client.get("/api/problems").json()["active"]}
        assert "external.entity_missing" in keys
    finally:
        client.__exit__(None, None, None)
