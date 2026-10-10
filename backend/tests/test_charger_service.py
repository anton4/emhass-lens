"""EV charger control: dry-run decisions compared with the automation, the minute tick, the SoC stop, live apply."""

from datetime import UTC, datetime, timedelta
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
        assert decided["summary"] == (
            "Would 'EMHASS: start charging' (emhass_start): press start, limit 8 A · was 0 A, plan 5.5 kW"
        )
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
        # keep the live scheduler's minute tick out of the way: it would add an EMHASS adjustment right after the
        # stop (the mode resumes charging once the target is back at 100 %) and muddle the calls asserted below
        assert client.post("/api/jobs/charger.tick/pause").status_code == 200
        clock.advance(seconds=60)  # the scheduler may fire the overdue stop itself; run it by hand as well
        run_job(client, "charger.soc_stop")
        stopped = wait_for_run(client, "charger.decide", before, summary="Did 'Target SoC")
        assert stopped["outcome"] == "ok", stopped
        assert (
            stopped["summary"]
            == "Did 'Target SoC reached: stop charging' (soc_limit): press stop, limit 0 A, target SoC back to 100 % "
            "· was 8 A, car 85 %, target 80 %"
        )
        calls = [s[0] for s in world.ha_services if s[0].startswith(("button", "number", "notify", "input_number"))]
        assert calls == ["button/press", "number/set_value", "notify/mobile_app_test", "input_number/set_value"]
        assert world.ha_states[TARGET_SOC]["state"] == "100.0" and world.ha_states[LIMIT]["state"] == "0.0"
        assert client.get(f"/api/runs/{stopped['id']}/artifacts/charger_readback").json()["agree"] is True
        # the target is 100 % now: the SoC clock resets, and EMHASS mode resumes charging (the automation does too)
        assert client.post("/api/jobs/charger.tick/resume").status_code == 200
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
        assert run["summary"] == (
            "Did 'EMHASS: start charging' (emhass_start): press start, limit 8 A · was 0 A, plan 5.5 kW"
        )
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


def test_the_charge_mode_can_be_switched_from_the_app_through_the_helper(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, "dry_run")
    try:
        status = client.get("/api/charger").json()
        assert status["charge_mode"]["entity"] == MODE and status["charge_mode"]["current"] == "EMHASS"
        assert status["charge_mode"]["options"] == ["Manual", "EMHASS", "Excess Solar"]
        before = newest_id(client, "charger.decide")
        m = len(world.ha_services)
        resp = client.post("/api/charger/mode", json={"option": "Excess Solar"})
        assert resp.status_code == 200, resp.text
        assert world.ha_services[m][0] == "input_select/select_option"
        assert world.ha_services[m][1] == {"entity_id": MODE, "option": "Excess Solar"}
        assert world.ha_states[MODE]["state"] == "Excess Solar"
        prime(client, world)
        decided = wait_for_run(client, "charger.decide", before)
        assert decided["outcome"] in ("dry_run", "noop", "ok"), decided
        bad = client.post("/api/charger/mode", json={"option": "Turbo"})
        assert bad.status_code == 400 and "not one of the helper's options" in bad.json()["detail"]
        assert len([s for s in world.ha_services if s[0] == "input_select/select_option"]) == 1
    finally:
        client.__exit__(None, None, None)


# --- PV reserved for Excess Solar -----------------------------------------------------------------------------


def test_excess_solar_charging_takes_its_share_out_of_the_pv_forecast_sent_to_emhass(
    tmp_path: Path, world: World
) -> None:
    from tests.world import solcast_day

    day = datetime(2026, 10, 9, tzinfo=TZ)
    for i, suffix in enumerate(("today", "tomorrow")):  # a sunny forecast: ~10 kW this afternoon
        world.set_state(f"sensor.solcast_pv_forecast_forecast_{suffix}", 10, solcast_day(day + timedelta(days=i), 12))
    client = client_for(tmp_path, world, FakeClock(START), pv_reserve={"enabled": True, "car_battery_kwh": 75})
    try:
        first = run_job(client, "emhass.mpc")  # EMHASS mode: nothing reserved, and this stores the plan
        assert first["outcome"] == "ok", first
        explain = client.get(f"/api/runs/{first['id']}/artifacts/explain").json()
        assert explain["ev_reserve"] == {
            "active": False,
            "why": "the charge mode is EMHASS, not Excess Solar",
            "energy_needed_wh": None,
            "energy_reserved_wh": 0,
            "until": None,
            "max_w": 0.0,
            "slots": 0,
            "soc": 50.0,
            "target_soc": 80.0,
        }

        world.set_state(MODE, "Excess Solar")
        prime(client, world)
        second = run_job(client, "emhass.mpc")
        assert second["outcome"] == "ok", second
        payloads = [p for name, p in world.emhass_actions if name == "naive-mpc-optim"]
        before, after = payloads[-2]["pv_power_forecast"], payloads[-1]["pv_power_forecast"]
        explain = client.get(f"/api/runs/{second['id']}/artifacts/explain").json()
        reserve = explain["ev_reserve"]
        assert reserve["active"] and reserve["why"].startswith("Excess Solar, car 50 % → 80 %, 22.5 kWh to go")
        assert reserve["energy_reserved_wh"] == 22500 and reserve["slots"] > 1
        # the plan says the house takes 1500 W; 10 kW of PV leaves 8.5 kW: 12 A = 8280 W for the car
        assert explain["slots"][0]["ev_reserved_w"] == 8280
        assert after[0] == before[0] - 8280
        assert after[0] == explain["slots"][0]["pv_w"]
        assert sum(before) - sum(after) == round(sum(r["ev_reserved_w"] for r in explain["slots"]))
        inputs = client.get(f"/api/runs/{second['id']}/artifacts/inputs").json()
        assert inputs["ev_reserve"]["active"] is True

        status = client.get("/api/charger").json()
        assert status["pv_reserve"]["active"] is True
        preview = client.post("/api/mpc/preview").json()
        assert preview["ev_reserve"]["active"] is True
        assert preview["explain"][0]["ev_reserved_w"] == 8280

        world.set_state(CAR_SOC, 80)
        prime(client, world)
        assert client.get("/api/charger").json()["pv_reserve"]["why"] == "the car is at 80 %, target 80 %"
    finally:
        client.__exit__(None, None, None)


def test_the_reserve_watches_the_car_even_while_the_controller_is_off(tmp_path: Path, world: World) -> None:
    client = client_for(tmp_path, world, FakeClock(START), mode="off", pv_reserve={"enabled": True})
    try:
        watched = container(client).extras["ha"].watched
        assert {MODE, STATE, CAR_SOC, TARGET_SOC, "input_number.ev_max_solar_current"} <= set(watched)
        assert LIMIT not in watched  # the controller's own entities stay unwatched while Off
        status = client.get("/api/charger").json()
        assert status["pv_reserve"]["why"] == "the charge mode is EMHASS, not Excess Solar"
    finally:
        client.__exit__(None, None, None)


def test_without_the_setting_nothing_is_reserved_or_reported(tmp_path: Path, world: World) -> None:
    client = client_for(tmp_path, world, FakeClock(START))
    try:
        assert client.get("/api/charger").json()["pv_reserve"] is None
        assert client.post("/api/mpc/preview").json()["ev_reserve"] is None
    finally:
        client.__exit__(None, None, None)


# --- a current limit something else changed --------------------------------------------------------------------

EARLY = datetime(2026, 10, 9, 11, 0, 30, tzinfo=UTC)  # early in the slot whose EV power was published


def charging_at_plan(tmp_path: Path, world: World) -> tuple[TestClient, FakeClock]:
    """Live, EMHASS mode: EMHASS Lens started the car at the planned 8 A and it is charging."""
    clock = FakeClock(EARLY)
    client = client_for(tmp_path, world, clock, mode="live")
    started = run_job(client, "charger.decide")
    assert started["outcome"] == "ok" and "limit 8 A" in started["summary"], started
    world.set_state(STATE, 4)
    prime(client, world)
    return client, clock


def decisions(client: TestClient, after_id: int) -> list[dict]:
    for _ in ticks():
        runs = [r for r in client.get("/api/runs", params={"job": "charger.decide"}).json() if r["id"] > after_id]
        if all(r["outcome"] != "running" for r in runs):
            return runs
    raise AssertionError("a charger decision never finished")


def test_a_limit_changed_by_someone_else_is_set_back_after_it_is_seen_twice(tmp_path: Path, world: World) -> None:
    client, clock = charging_at_plan(tmp_path, world)
    try:
        before = newest_id(client, "charger.decide")
        world.set_state(LIMIT, 16)  # the car's app
        prime(client, world)
        run_job(client, "charger.tick")
        assert decisions(client, before) == []  # 90 s settle after our own write
        clock.advance(100)
        run_job(client, "charger.tick")
        assert decisions(client, before) == []  # seen once
        clock.advance(60)
        run_job(client, "charger.tick")
        [fixed] = decisions(client, before)
        assert fixed["outcome"] == "ok", fixed
        assert fixed["summary"].startswith("Drift: limit 16 A, expected 8 A; set back · Did 'EMHASS: adjust")
        assert float(world.ha_states[LIMIT]["state"]) == 8
        assert client.get("/api/charger").json()["drift"]["corrections_1h"] == 1
    finally:
        client.__exit__(None, None, None)


def test_a_new_plan_value_applies_at_once_without_the_drift_guard(tmp_path: Path, world: World) -> None:
    client, _clock = charging_at_plan(tmp_path, world)
    try:
        before = newest_id(client, "charger.decide")
        world.set_state(P_DEF, 7590, updated=EARLY)  # the plan now asks 11 A
        prime(client, world)
        run_job(client, "charger.tick")
        [adjusted] = decisions(client, before)
        assert adjusted["summary"].startswith("Did 'EMHASS: adjust the current' (emhass_adjust): limit 11 A")
    finally:
        client.__exit__(None, None, None)


def test_something_that_keeps_changing_the_limit_stops_the_corrections(tmp_path: Path, world: World) -> None:
    client, clock = charging_at_plan(tmp_path, world)
    try:
        before = newest_id(client, "charger.decide")
        for _ in range(4):
            world.set_state(LIMIT, 16)
            prime(client, world)
            clock.advance(95)
            run_job(client, "charger.tick")
            clock.advance(60)
            run_job(client, "charger.tick")
            decisions(client, before)
            prime(client, world)
        assert len(decisions(client, before)) == 3
        assert float(world.ha_states[LIMIT]["state"]) == 16
        assert client.get("/api/charger").json()["drift"]["fighting"]["field"] == "current limit"
        run_job(client, "health.evaluate")
        assert "charger.fighting" in {p["key"] for p in client.get("/api/problems").json()["active"]}
    finally:
        client.__exit__(None, None, None)
