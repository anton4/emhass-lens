"""Qilowatt market control: shadow decisions compared with the automation, live sessions through the shared Sofar
writer, the write throttle over time, a session end handed straight back to the plan, restarts and refusals."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from emhass_lens.core.clock import FakeClock
from tests.test_phase1 import prime, run_job, ticks
from tests.test_phase2 import LEGACY_SWITCH, live_client
from tests.world import TZ, World

START = datetime(2026, 10, 9, 11, 13, 0, tzinfo=UTC)
EARLY = datetime(2026, 10, 9, 11, 5, 0, tzinfo=UTC)  # room to let a cooldown pass without leaving the slot
SOURCE, MODE, POWER = "sensor.qw_source", "sensor.qw_mode", "sensor.qw_powerlimit"
SESSION = "input_select.qilowatt_session_state"
ENABLE = "input_boolean.emhass_automation"
QW_ENABLE = "input_boolean.qilowatt_automation"
GRID = "number.sofar_passive_mode_grid_power"
BMAX = "number.sofar_passive_mode_battery_power_max"
BMIN = "number.sofar_passive_mode_battery_power_min"
FEEDIN = "number.sofar_feedin_max_power"
STATE = "input_select.emhass_passive_state"
APPLY = "button.sofar_passive_mode_battery_charge_discharge"
FEEDIN_BUTTON = "button.sofar_feedin_limitation_mode"
OLD = datetime(2026, 10, 9, 8, 0, tzinfo=UTC)


@pytest.fixture
def world() -> World:
    w = World()
    w.standard_entities(datetime(2026, 10, 9, tzinfo=TZ))
    w.set_state(LEGACY_SWITCH, "off")
    w.set_state("select.sofar_charger_use_mode", "Passive Mode")
    w.set_state(ENABLE, "on")
    w.set_state(QW_ENABLE, "on")
    w.set_state(STATE, "Self-use battery or PV")
    w.set_state(SESSION, "none")
    for entity, value in {GRID: 0, BMAX: 20000, BMIN: -20000, FEEDIN: 0}.items():
        w.set_state(entity, value)
    w.set_state(APPLY, OLD.isoformat(), updated=OLD)
    w.set_state(FEEDIN_BUTTON, OLD.isoformat(), updated=OLD)
    w.set_state(SOURCE, "kratt")
    w.set_state(MODE, "none")
    w.set_state(POWER, 0)
    w.set_state("sensor.sofar_battery_capacity_1", 55)
    w.set_state("sensor.sofar_pv_power_total_watt", 0)
    w.set_state("sensor.p_batt_forecast", -6000)  # the plan for this slot: force charge from the grid
    w.set_state("sensor.p_grid_forecast", 4560)
    w.set_state("sensor.p_pv_forecast", 0)
    w.set_state("sensor.p_pv_curtailment", 0)
    return w


def client_for(
    tmp_path: Path, world: World, clock: FakeClock, mode: str, inverter_mode: str = "live", **market
) -> TestClient:
    thresholds = {"settle_s": 0, **market.pop("thresholds", {})}
    return live_client(
        tmp_path,
        world,
        clock,
        market={"mode": mode, "thresholds": thresholds, **market},
        inverter={"mode": inverter_mode},
        notifications={"mobile_service": "notify.mobile_app_test"},
    )


def container(client: TestClient):
    return client.app.state.container  # type: ignore[attr-defined]


_pushes = 0


def push(client: TestClient, world: World, entity: str, value) -> None:
    """What the WebSocket would deliver when a Qilowatt sensor changes (each push has a fresh timestamp)."""
    global _pushes
    _pushes += 1
    state = world.set_state(entity, value, updated=START + timedelta(seconds=_pushes))
    portal = client.portal
    assert portal is not None
    portal.call(container(client).extras["ha"]._set_state, entity, state)


def manual_run(client: TestClient, job: str) -> dict:
    run_id = client.post(f"/api/jobs/{job}/run").json()["run_id"]
    assert run_id is not None, f"{job} didn't start"
    for _ in ticks():
        run = client.get(f"/api/runs/{run_id}").json()
        if run["outcome"] != "running":
            return run
    raise AssertionError(f"{job} didn't finish")


def wait_for_run(client: TestClient, job: str, after_id: int, trigger: str = "event", summary: str = "") -> dict:
    """The run of `job` after `after_id` with this trigger (and a summary starting with `summary`) that did
    something. Two pushes in a row make two runs, and a write can trigger a queued rerun: those extra runs find
    nothing left to do (noop), so the newest run that acted wins, and a noop only when nothing else is there."""
    for _ in ticks():
        # the job's lock is held through any queued rerun, so wait for the lock, not just for the first record
        info = next(j for j in client.get("/api/jobs").json() if j["id"] == job)
        if info["running"]:
            continue
        runs = client.get("/api/runs", params={"job": job}).json()
        new = [r for r in runs if r["id"] > after_id and r["trigger"] == trigger]
        if any(r["outcome"] == "running" for r in new):
            continue
        done = [r for r in new if r["outcome"] != "skipped" and (r["summary"] or "").startswith(summary)]
        acted = [r for r in done if r["outcome"] != "noop"]
        if acted:
            return acted[0]
        if done:
            return done[0]
    raise AssertionError(f"no new {job} run")


def newest_id(client: TestClient, job: str) -> int:
    runs = client.get("/api/runs", params={"job": job}).json()
    return runs[0]["id"] if runs else 0


def calls(world: World, since: int = 0) -> list[tuple[str, str | None]]:
    return [(s[0], s[1].get("entity_id")) for s in world.ha_services[since:] if not s[0].startswith("persistent")]


def presses(world: World, entity: str, since: int = 0) -> int:
    return sum(1 for s in world.ha_services[since:] if s[0] == "button/press" and s[1].get("entity_id") == entity)


def test_shadow_decides_and_compares_with_the_automation(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, "shadow")
    try:
        before = newest_id(client, "market.reconcile")
        push(client, world, POWER, 5000)
        push(client, world, MODE, "mfrrup")
        decided = wait_for_run(client, "market.reconcile", before)
        assert decided["outcome"] == "dry_run", decided
        assert decided["summary"] == "Would: Kratt sell 5000W"
        assert not [c for c in calls(world) if c[0].startswith(("number", "button", "input_"))]
        artifact = client.get(f"/api/runs/{decided['id']}/artifacts/market_decision").json()
        assert "session start" in artifact["decision"]["throttle"]["bypass_reasons"]
        # the automation then does the same ...
        world.set_state(SESSION, "sell")
        world.set_state(ENABLE, "off")
        world.set_state(STATE, "Force discharge")
        world.set_state(GRID, -5000)
        world.set_state(FEEDIN, 15500)
        prime(client, world)
        same = run_job(client, "market.compare")
        assert same["outcome"] == "ok", same
        assert same["summary"] == f"Decision #{decided['id']}: the automation did the same"
        # ... but ignores a bigger command (shadow follows the automation's session select: continuing)
        push(client, world, POWER, 7000)
        bigger = wait_for_run(client, "market.reconcile", decided["id"])
        assert bigger["summary"] == "Would: Kratt sell 7000W"
        differs = run_job(client, "market.compare")
        assert differs["outcome"] == "mismatch"
        assert "grid_power_w: expected -7000.0, HA shows -5000.0" in differs["summary"]
        status = client.get("/api/market").json()
        assert status["agreement_24h"] == {"hours": 24, "compared": 2, "agreed": 1, "rate": 0.5}
        assert status["sensors"]["ha_session"] == "sell" and status["session"] is None
    finally:
        client.__exit__(None, None, None)


def test_live_runs_a_session_throttles_writes_and_hands_the_inverter_back_to_the_plan(
    tmp_path: Path, world: World
) -> None:
    clock = FakeClock(EARLY)
    client = client_for(tmp_path, world, clock, "live")
    try:
        assert run_job(client, "emhass.mpc")["outcome"] == "ok"  # a fresh plan to hand back to
        n = len(world.ha_services)
        before = newest_id(client, "market.reconcile")
        push(client, world, POWER, 5000)
        push(client, world, MODE, "mfrrup")
        started = wait_for_run(client, "market.reconcile", before, summary="Kratt sell 5000W: set")
        assert started["outcome"] == "ok", started
        assert started["summary"].startswith("Kratt sell 5000W: set 'Force discharge', grid -5000 W")
        started = wait_for_run(client, "market.reconcile", started["id"] - 1)  # let the queued rerun finish too
        assert calls(world, n) == [
            ("input_select/select_option", SESSION),
            ("input_boolean/turn_off", ENABLE),
            ("number/set_value", FEEDIN),
            ("button/press", FEEDIN_BUTTON),
            ("input_select/select_option", STATE),
            ("number/set_value", GRID),
            ("number/set_value", BMAX),
            ("number/set_value", BMIN),
            ("button/press", APPLY),
        ]
        assert world.ha_states[GRID]["state"] == "-5000.0" and world.ha_states[ENABLE]["state"] == "off"
        status = client.get("/api/market").json()
        assert status["session"]["direction"] == "sell" and status["session"]["power_w"] == 5000
        assert "market session" in client.get("/api/inverter").json()["preconditions"]
        held = manual_run(client, "inverter.decide")
        assert held["outcome"] == "noop" and "market session" in held["summary"]

        # within the deadband: nothing written; a big change is blocked by the cooldown ...
        push(client, world, POWER, 5200)
        inside = wait_for_run(client, "market.reconcile", started["id"])
        assert inside["summary"] == "Kratt sell 5200W: registers unchanged"
        push(client, world, POWER, 7000)
        cooled = wait_for_run(client, "market.reconcile", inside["id"])
        assert cooled["summary"] == "Kratt sell 7000W: registers unchanged"
        assert presses(world, APPLY, n) == 1
        # ... until the cooldown passed
        clock.advance(seconds=181)
        push(client, world, POWER, 7000)
        written = wait_for_run(client, "market.reconcile", cooled["id"])
        assert "grid -7000 W" in written["summary"]
        assert presses(world, APPLY, n) == 2

        # the session ends: the plan's targets are written in one go, never the automation's safe state
        m = len(world.ha_services)
        decides_before = newest_id(client, "inverter.decide")
        push(client, world, MODE, "none")
        ended = wait_for_run(client, "market.reconcile", written["id"])
        assert ended["outcome"] == "ok", ended
        assert ended["summary"].endswith("Control returned to EMHASS. Handed the inverter back to the plan.")
        handoff = wait_for_run(client, "inverter.decide", decides_before, trigger="manual")
        assert handoff["outcome"] == "ok" and handoff["summary"].startswith("Set 'Force charge'"), handoff
        assert calls(world, m)[:2] == [("input_select/select_option", SESSION), ("input_boolean/turn_on", ENABLE)]
        assert presses(world, APPLY, m) == 1
        assert world.ha_states[GRID]["state"] == "5600.0"  # the plan, not grid 0
        assert world.ha_states[SESSION]["state"] == "none" and world.ha_states[ENABLE]["state"] == "on"
        status = client.get("/api/market").json()
        assert status["session"] is None and status["wear_24h"]["our_commits"] >= 4
        [session] = client.get("/api/market/sessions").json()
        assert session["direction"] == "sell" and session["end_reason"] == "mode_cleared" and session["ended_at"]
    finally:
        client.__exit__(None, None, None)


def test_a_session_end_without_a_fresh_plan_falls_back_to_the_safe_state(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, "live")
    try:
        before = newest_id(client, "market.reconcile")
        push(client, world, POWER, 5000)
        push(client, world, MODE, "mfrrup")
        started = wait_for_run(client, "market.reconcile", before)
        assert started["outcome"] == "ok", started
        m = len(world.ha_services)
        push(client, world, MODE, "none")
        ended = wait_for_run(client, "market.reconcile", started["id"])
        assert ended["outcome"] == "ok", ended
        assert ended["summary"].endswith("No fresh plan to hand back to: set the safe state.")
        assert presses(world, APPLY, m) == 1
        assert world.ha_states[GRID]["state"] == "0.0" and world.ha_states[STATE]["state"] == "Self-use battery or PV"
    finally:
        client.__exit__(None, None, None)


def test_a_restart_keeps_the_session_and_the_cooldown(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, "live")
    try:
        before = newest_id(client, "market.reconcile")
        push(client, world, POWER, 5000)
        push(client, world, MODE, "mfrrup")
        assert wait_for_run(client, "market.reconcile", before)["outcome"] == "ok"
    finally:
        client.__exit__(None, None, None)
    client = client_for(tmp_path, world, clock, "live")
    try:
        status = client.get("/api/market").json()
        assert status["session"]["direction"] == "sell"  # restored from app.db before any run
        n = len(world.ha_services)
        push(client, world, POWER, 7000)
        blocked = wait_for_run(client, "market.reconcile", 0)
        assert blocked["summary"] == "Kratt sell 7000W: registers unchanged"  # the cooldown came back from app.db
        assert presses(world, APPLY, n) == 0
        push(client, world, MODE, "none")
        ended = wait_for_run(client, "market.reconcile", blocked["id"])
        assert ended["outcome"] == "ok" and client.get("/api/market").json()["session"] is None
    finally:
        client.__exit__(None, None, None)


def test_live_refusals_and_the_kill_switch(tmp_path: Path, world: World) -> None:
    world.set_state(MODE, "mfrrup")
    world.set_state(POWER, 5000)
    world.set_state(QW_ENABLE, "off")
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, "live")
    try:
        blocked = manual_run(client, "market.reconcile")
        assert blocked["outcome"] == "noop" and blocked["summary"].startswith(
            "Not in control (input_boolean.qilowatt_automation is 'off')"
        )
        world.set_state(QW_ENABLE, "on")
        prime(client, world)
        started = manual_run(client, "market.reconcile")
        assert started["outcome"] == "ok" and started["summary"].startswith("Kratt sell 5000W: set")
        m = len(world.ha_services)
        forced = client.post("/api/market/reconcile", json={"force_end": True}).json()
        run = client.get(f"/api/runs/{forced['run_id']}").json()
        for _ in ticks():
            if run["outcome"] != "running":
                break
            run = client.get(f"/api/runs/{forced['run_id']}").json()
        assert run["outcome"] == "ok" and "session ended (forced)" in run["summary"], run
        assert client.get("/api/market").json()["session"] is None
        assert presses(world, APPLY, m) == 1
        container(client).extras["ha"].connected = False
        refused = manual_run(client, "market.reconcile")
        assert refused["outcome"] == "refused" and "Not connected" in refused["summary"]
    finally:
        client.__exit__(None, None, None)


def test_switching_live_off_during_a_session_closes_it_without_writing(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, "live")
    try:
        before = newest_id(client, "market.reconcile")
        push(client, world, POWER, 5000)
        push(client, world, MODE, "mfrrup")
        assert wait_for_run(client, "market.reconcile", before)["outcome"] == "ok"
        n = len(world.ha_services)
        rev = client.get("/api/settings").json()["revision"]
        assert (
            client.patch(
                "/api/settings", json={"base_revision": rev, "changes": {"market": {"mode": "off"}}}
            ).status_code
            == 200
        )
        status = client.get("/api/market").json()
        assert status["session"] is None and "switched to off during a session" in (status["notice"] or "")
        assert presses(world, APPLY, n) == 0
        [session] = client.get("/api/market/sessions").json()
        assert session["end_reason"] == "controller_off"
    finally:
        client.__exit__(None, None, None)


def test_a_burst_settles_into_one_reconcile(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, "shadow", thresholds={"settle_s": 2})
    try:
        before = newest_id(client, "market.reconcile")
        push(client, world, SOURCE, "kratt")
        push(client, world, POWER, 5000)
        push(client, world, MODE, "mfrrup")
        import time

        time.sleep(0.05)
        assert newest_id(client, "market.reconcile") == before  # still settling
        clock.advance(seconds=2)
        decided = wait_for_run(client, "market.reconcile", before)
        assert decided["summary"] == "Would: Kratt sell 5000W"
        time.sleep(0.05)
        runs = [r for r in client.get("/api/runs", params={"job": "market.reconcile"}).json() if r["id"] > before]
        assert len(runs) == 1
    finally:
        client.__exit__(None, None, None)
