"""Inverter control: dry-run decisions compared with the automation, and live apply with readback."""

from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from emhass_lens.core.clock import FakeClock
from tests.test_phase1 import prime, run_job
from tests.test_phase2 import live_client
from tests.world import TZ, World

START = datetime(2026, 10, 9, 11, 13, 0, tzinfo=UTC)
SOFAR = {
    "number.sofar_passive_mode_grid_power": 0,
    "number.sofar_passive_mode_battery_power_max": 20000,
    "number.sofar_passive_mode_battery_power_min": -20000,
    "number.sofar_feedin_max_power": 15500,
}


@pytest.fixture
def world() -> World:
    w = World()
    w.standard_entities(datetime(2026, 10, 9, tzinfo=TZ))
    w.set_state("switch.nordpool_ee_prices_emhass_auto_mpc", "off")
    w.set_state("select.sofar_charger_use_mode", "Passive Mode")
    w.set_state("input_boolean.emhass_automation", "on")
    w.set_state("input_select.emhass_passive_state", "Self-use battery or PV")
    for entity, value in SOFAR.items():
        w.set_state(entity, value)
    # what EMHASS published for the slot: force charge from the grid
    w.set_state("sensor.p_batt_forecast", -6000)
    w.set_state("sensor.p_grid_forecast", 4560)
    w.set_state("sensor.p_pv_forecast", 0)
    w.set_state("sensor.p_pv_curtailment", 0)
    return w


def set_mode(client: TestClient, world: World, mode: str) -> None:
    rev = client.get("/api/settings").json()["revision"]
    assert (
        client.patch("/api/settings", json={"base_revision": rev, "changes": {"inverter": {"mode": mode}}}).status_code
        == 200
    )
    prime(client, world)


def test_dry_run_decides_and_compares_with_the_automation(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        set_mode(client, world, "dry_run")
        decided = run_job(client, "inverter.decide")
        assert decided["outcome"] == "dry_run", decided
        assert "'Force charge' (rule g): grid 5600 W, battery -3000…20000 W" in decided["summary"]
        assert world.ha_services == [] or all(not s[0].startswith("number") for s in world.ha_services)

        decision = client.get(f"/api/runs/{decided['id']}/artifacts/decision").json()["decision"]
        # the automation then sets the same values (feed-in follows the slot's export price) ...
        world.set_state("number.sofar_feedin_max_power", decision["feedin_max_w"])
        world.set_state("input_select.emhass_passive_state", "Force charge")
        world.set_state("number.sofar_passive_mode_grid_power", 5600)
        world.set_state("number.sofar_passive_mode_battery_power_min", -3000)
        prime(client, world)
        same = run_job(client, "inverter.compare")
        assert same["outcome"] == "ok", same
        # ... or something else
        world.set_state("number.sofar_passive_mode_grid_power", 5000)
        prime(client, world)
        differs = run_job(client, "inverter.compare")
        assert differs["outcome"] == "mismatch"
        assert "grid_power_w: decided 5600, automation set 5000.0" in differs["summary"]
        status = client.get("/api/inverter").json()
        assert status["agreement_24h"] == {"hours": 24, "compared": 2, "agreed": 1, "rate": 0.5}
    finally:
        client.__exit__(None, None, None)


def test_not_in_control_when_the_automation_switch_is_off(tmp_path: Path, world: World) -> None:
    world.set_state("input_boolean.emhass_automation", "off")
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        set_mode(client, world, "dry_run")
        run = run_job(client, "inverter.decide")
        assert run["outcome"] == "noop"
        assert "mFRR" in run["summary"]
    finally:
        client.__exit__(None, None, None)


def test_live_applies_and_reads_back(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        assert run_job(client, "emhass.mpc")["outcome"] == "ok"  # a fresh plan is required before touching the inverter
        set_mode(client, world, "live")
        run = run_job(client, "inverter.decide")
        assert run["outcome"] == "ok", run
        services = [s[0] for s in world.ha_services]
        decision = client.get(f"/api/runs/{run['id']}/artifacts/decision").json()["decision"]
        feedin_changed = decision["feedin_max_w"] != 15500
        assert services.count("number/set_value") == 3 + feedin_changed  # passive mode (3) + feed-in if it changed
        assert "button/press" in services
        assert world.ha_states["number.sofar_passive_mode_grid_power"]["state"] == "5600.0"
        readback = client.get(f"/api/runs/{run['id']}/artifacts/readback").json()
        assert readback["agree"] is True
    finally:
        client.__exit__(None, None, None)


def test_live_refuses_with_a_stale_plan(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        set_mode(client, world, "live")
        run = run_job(client, "inverter.decide")  # no plan stored at all
        assert run["outcome"] == "refused"
        assert "stale" in run["summary"]
        assert not [s for s in world.ha_services if s[0].startswith("number")]
    finally:
        client.__exit__(None, None, None)
