"""EV charger control: dry-run decisions compared with the automation, the minute tick, the SoC stop, live apply."""

from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from emhass_lens.core.clock import FakeClock
from tests.test_phase1 import prime, run_job, ticks
from tests.test_phase2 import LEGACY_SWITCH, live_client
from tests.world import TZ, World

START = datetime(2026, 10, 9, 11, 13, 0, tzinfo=UTC)
MODE = "input_select.ev_charge_mode"
STATE = "sensor.abb_terra_ac_charger_charging_state_raw"
LIMIT = "number.abb_terra_ac_charger_charging_current_limit"
START_BUTTON = "button.abb_terra_ac_charger_start_charging"
STOP_BUTTON = "button.abb_terra_ac_charger_stop_charging"
CAR_SOC = "sensor.model_3_usable_battery_level"
TARGET_SOC = "input_number.ev_target_soc"
PV = "sensor.sofar_pv_power_total_watt"
P_DEF = "sensor.p_deferrable0"


@pytest.fixture
def world() -> World:
    w = World()
    w.standard_entities(datetime(2026, 10, 9, tzinfo=TZ))
    w.set_state(LEGACY_SWITCH, "off")
    w.set_state(MODE, "EMHASS")
    w.set_state(STATE, 1)
    w.set_state(LIMIT, 0)
    w.set_state(CAR_SOC, 50)
    w.set_state(TARGET_SOC, 80)
    w.set_state("input_number.ev_max_solar_current", 16)
    w.set_state(PV, 0, updated=START)
    w.set_state("sensor.potential_pv_power_advanced", 0, updated=START)
    w.set_state("sensor.sofar_active_power_load_sys_watt", 500)
    w.set_state(P_DEF, 5520)  # published for this slot (updated 11:00 by default)
    return w


def client_for(tmp_path: Path, world: World, clock: FakeClock, mode: str = "dry_run", **charger) -> TestClient:
    # short windows: the fake clock doesn't move while a job polls, and a one-minute SoC hold stays inside the slot
    limits = {"compare_window_s": 2, "soc_compare_window_s": 2, "soc_for_s": 60}
    return live_client(
        tmp_path,
        world,
        clock,
        charger={"mode": mode, "limits": limits, **charger},
        notifications={"mobile_service": "notify.mobile_app_test"},
    )


def container(client: TestClient):
    return client.app.state.container  # type: ignore[attr-defined]


def wait_for_run(client: TestClient, job: str, after_id: int, summary: str = "") -> dict:
    """The newest finished run of `job` started on demand (run_now) after `after_id` whose summary starts with
    `summary`. Scheduled fires are ignored, and so is a duplicate that was skipped because the run under test
    still held the job's lock. The live scheduler can add a further decision right after the one awaited (a
    tick after the stop resumes EMHASS mode), so callers name the run they mean."""
    for _ in ticks():
        runs = client.get("/api/runs", params={"job": job}).json()
        new = [r for r in runs if r["id"] > after_id and r["trigger"] == "manual"]
        if any(r["outcome"] == "running" for r in new):
            continue
        done = [r for r in new if r["outcome"] != "skipped" and (r["summary"] or "").startswith(summary)]
        if done:
            return done[0]
    raise AssertionError(f"no new {job} run")


def newest_id(client: TestClient, job: str) -> int:
    runs = client.get("/api/runs", params={"job": job}).json()
    return runs[0]["id"] if runs else 0


def services(world: World, since: int = 0) -> list[tuple[str, dict]]:
    return world.ha_services[since:]


def test_dry_run_decides_and_compares_with_the_automation(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock)
    try:
        decided = run_job(client, "charger.decide")
        assert decided["outcome"] == "dry_run", decided
        assert decided["summary"] == "Would 'EMHASS: start charging' (emhass_start): press start, limit 8 A"
        assert not [s for s in world.ha_services if s[0].startswith(("button", "number", "notify"))]
        calls = client.get(f"/api/runs/{decided['id']}/artifacts/charger_calls").json()
        assert {"service": "notify", "message": "EMHASS started EV at 8A", "ok": None, "dry_run": True} in calls
        # the automation then starts the car at 8 A ...
        world.set_state(LIMIT, 8)
        world.set_state(STATE, 4)
        prime(client, world)
        same = run_job(client, "charger.compare")
        assert same["outcome"] == "ok", same
        assert same["summary"] == f"Decision #{decided['id']}: the automation did the same"
        # ... a later decision asks for 8 A again but the automation left 6 A
        world.set_state(LIMIT, 6)
        prime(client, world)
        decided = run_job(client, "charger.decide")
        assert "(emhass_adjust): limit 8 A" in decided["summary"]
        differs = run_job(client, "charger.compare")
        assert differs["outcome"] == "mismatch"
        assert "current_limit_a: decided 8, automation set 6.0" in differs["summary"]
        status = client.get("/api/charger").json()
        assert status["agreement_24h"] == {"hours": 24, "compared": 2, "agreed": 1, "rate": 0.5}
        assert status["last"]["decision"]["rule"] == "emhass_adjust"
    finally:
        client.__exit__(None, None, None)


def test_the_minute_tick_starts_an_excess_solar_decision_when_due(tmp_path: Path, world: World) -> None:
    world.set_state(MODE, "Excess Solar")
    world.set_state(PV, 8000, updated=START)
    world.set_state("sensor.sofar_active_power_load_sys_watt", 1000)
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock)
    try:
        before = newest_id(client, "charger.decide")
        run_job(client, "charger.tick")
        decided = wait_for_run(client, "charger.decide", before)
        assert decided["outcome"] == "dry_run"
        assert "(solar_start): press start, limit 10 A" in decided["summary"]
        tick = client.get("/api/charger").json()["last_tick"]
        assert tick["rule"] == "solar_start" and tick["derived"]["solar_target_a"] == 10
        # nothing to do: the tick records only its reasoning
        world.set_state(PV, 1000, updated=START)
        prime(client, world)
        run_job(client, "charger.tick")
        assert newest_id(client, "charger.decide") == decided["id"]
        assert client.get("/api/charger").json()["last_tick"]["rule"] == "none"
    finally:
        client.__exit__(None, None, None)


def test_the_soc_stop_fires_once_after_the_holding_time(tmp_path: Path, world: World) -> None:
    world.set_state(CAR_SOC, 85)
    world.set_state(STATE, 4)
    world.set_state(LIMIT, 8)
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, mode="live")
    try:
        run_job(client, "charger.tick")
        soc = client.get("/api/charger").json()["soc"]
        assert soc["since"] is not None and soc["fired"] is False and soc["due_at"] is not None
        before = newest_id(client, "charger.decide")
        assert before == 0
        clock.advance(seconds=60)  # the scheduler may fire the overdue stop itself; run it by hand as well
        run_job(client, "charger.soc_stop")
        stopped = wait_for_run(client, "charger.decide", before, summary="Did 'Target SoC")
        assert stopped["outcome"] == "ok", stopped
        assert (
            stopped["summary"]
            == "Did 'Target SoC reached: stop charging' (soc_limit): press stop, limit 0 A, target SoC back to 100 %"
        )
        calls = [s[0] for s in world.ha_services if s[0].startswith(("button", "number", "notify", "input_number"))]
        assert calls == ["button/press", "number/set_value", "notify/mobile_app_test", "input_number/set_value"]
        assert world.ha_states[TARGET_SOC]["state"] == "100.0" and world.ha_states[LIMIT]["state"] == "0.0"
        assert client.get(f"/api/runs/{stopped['id']}/artifacts/charger_readback").json()["agree"] is True
        # the target is 100 % now: the SoC clock resets, and EMHASS mode resumes charging (the automation does too)
        run_job(client, "charger.tick")
        assert client.get("/api/charger").json()["soc"] == {"since": None, "fired": False, "due_at": None}
        resumed = wait_for_run(client, "charger.decide", stopped["id"], summary="Did 'EMHASS")
        assert "(emhass_adjust): limit 8 A" in resumed["summary"], resumed
        run_job(client, "charger.soc_stop")  # nothing due: no second stop
        runs = client.get("/api/runs", params={"job": "charger.decide"}).json()
        assert len([r for r in runs if "(soc_limit)" in (r["summary"] or "")]) == 1
    finally:
        client.__exit__(None, None, None)


def test_live_starts_the_car_and_reads_back(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, mode="live")
    try:
        run = run_job(client, "charger.decide")
        assert run["outcome"] == "ok", run
        assert run["summary"] == "Did 'EMHASS: start charging' (emhass_start): press start, limit 8 A"
        calls = [
            (s[0], s[1].get("entity_id")) for s in world.ha_services if s[0].startswith(("button", "number", "notify"))
        ]
        assert calls == [("button/press", START_BUTTON), ("number/set_value", LIMIT), ("notify/mobile_app_test", None)]
        assert world.ha_states[LIMIT]["state"] == "8.0"
        assert client.get(f"/api/runs/{run['id']}/artifacts/charger_readback").json()["agree"] is True
    finally:
        client.__exit__(None, None, None)


def test_live_refusals(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, mode="live", entities={"automation": "automation.ev_charging"})
    try:
        world.set_state("automation.ev_charging", "on")
        prime(client, world)
        blocked = run_job(client, "charger.decide")
        assert blocked["outcome"] == "noop" and blocked["summary"].startswith(
            "Not in control (automation.ev_charging is on"
        )
        world.set_state("automation.ev_charging", "off")
        world.set_state("input_number.ev_max_solar_current", 32)
        world.set_state(P_DEF, 20000)
        prime(client, world)
        refused = run_job(client, "charger.decide")
        assert refused["outcome"] == "refused" and "29 A is outside 0…16 A" in refused["summary"]
        container(client).extras["ha"].connected = False
        disconnected = run_job(client, "charger.decide")
        assert disconnected["outcome"] == "refused" and "Not connected" in disconnected["summary"]
        assert not [s for s in world.ha_services if s[0].startswith(("button", "number"))]
    finally:
        client.__exit__(None, None, None)


def test_live_rereads_the_charger_before_writing(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, mode="live")
    try:
        world.set_state(STATE, 4)  # the cache still says plugged in (1), the charger already charges at 8 A
        world.set_state(LIMIT, 8)
        run = run_job(client, "charger.decide")
        assert run["outcome"] == "noop" and "already charging at the planned 8 A" in run["summary"]
        assert not [s for s in world.ha_services if s[0] == "button/press"]
    finally:
        client.__exit__(None, None, None)


def test_the_publish_triggers_a_decision_and_a_failed_notification_keeps_the_outcome(
    tmp_path: Path, world: World
) -> None:
    world.failing_services.add("notify/mobile_app_test")
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, mode="live")
    try:
        assert run_job(client, "emhass.mpc")["outcome"] == "ok"
        before = newest_id(client, "charger.decide")
        assert run_job(client, "emhass.publish")["outcome"] == "ok"
        decided = wait_for_run(client, "charger.decide", before)
        assert decided["outcome"] == "ok", decided
        assert decided["summary"].endswith("; the notification failed")
        artifact = client.get(f"/api/runs/{decided['id']}/artifacts/charger_decision").json()
        assert artifact["trigger"] == "emhass_update"
        calls = client.get(f"/api/runs/{decided['id']}/artifacts/charger_calls").json()
        assert [c["ok"] for c in calls] == [True, True, False]
    finally:
        client.__exit__(None, None, None)
