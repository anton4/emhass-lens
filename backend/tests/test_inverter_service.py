"""Inverter control: dry-run decisions compared with the automation, and live apply with readback."""

from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from emhass_lens.core.clock import FakeClock
from emhass_lens.domain.inverter import Decision, Observed, Targets
from emhass_lens.services.inverter import describe
from tests.test_phase1 import prime, run_job, ticks
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


def settings(summary: str) -> str:
    """A decide run's summary without the plan's battery power at its end."""
    return summary.split(" · P_batt")[0]


def test_dry_run_decides_and_compares_with_the_automation(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        set_mode(client, world, "dry_run")
        decided = run_job(client, "inverter.decide")
        assert decided["outcome"] == "dry_run", decided
        assert "'Force charge' (rule force_charge): grid 18800 W, battery -20000…20000 W" in decided["summary"]
        assert world.ha_services == [] or all(not s[0].startswith("number") for s in world.ha_services)

        decision = client.get(f"/api/runs/{decided['id']}/artifacts/decision").json()["decision"]
        # the automation then sets the same values (feed-in follows the slot's export price) ...
        world.set_state("number.sofar_feedin_max_power", decision["feedin_max_w"])
        world.set_state("input_select.emhass_passive_state", "Force charge")
        world.set_state("number.sofar_passive_mode_grid_power", 18800)
        prime(client, world)
        same = run_job(client, "inverter.compare")
        assert same["outcome"] == "ok", same
        # ... or something else
        world.set_state("number.sofar_passive_mode_grid_power", 5000)
        prime(client, world)
        differs = run_job(client, "inverter.compare")
        assert differs["outcome"] == "mismatch"
        assert "grid_power_w: decided 18800, automation set 5000.0" in differs["summary"]
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
        feedin_changed = decision["feedin_needed"] and decision["feedin_max_w"] != 15500
        assert services.count("number/set_value") == 3 + feedin_changed  # passive mode (3) + feed-in if it changed
        assert "button/press" in services
        assert world.ha_states["number.sofar_passive_mode_grid_power"]["state"] == "18800.0"
        readback = client.get(f"/api/runs/{run['id']}/artifacts/readback").json()
        assert readback["agree"] is True
    finally:
        client.__exit__(None, None, None)


def test_the_planned_modes_come_from_the_newest_plan(tmp_path: Path, world: World) -> None:
    client = live_client(tmp_path, world, FakeClock(START))
    try:
        assert client.get("/api/inverter/ahead").json() == {"generated_at": None, "run_id": None, "slots": []}
        mpc = run_job(client, "emhass.mpc")
        assert mpc["outcome"] == "ok"
        ahead = client.get("/api/inverter/ahead").json()
        assert ahead["run_id"] == mpc["id"] and ahead["generated_at"]
        slots = ahead["slots"]
        assert slots, ahead
        # after the slot in force (11:00), in order, each with a passive state
        assert slots[0]["slot"] > "2026-10-09T11:00:00.000+00:00"
        assert [s["slot"] for s in slots] == sorted(s["slot"] for s in slots)
        assert all(s["state"] and s["rule"] for s in slots)
    finally:
        client.__exit__(None, None, None)


def test_back_to_back_force_charge_slots_write_nothing(tmp_path: Path, world: World) -> None:
    """Runs 2791 and 2803: the second slot's smaller P_grid used to lower the grid target and press apply again."""
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        assert run_job(client, "emhass.mpc")["outcome"] == "ok"
        set_mode(client, world, "live")
        assert run_job(client, "inverter.decide")["outcome"] == "ok"
        assert "button/press" in [s[0] for s in world.ha_services]
        written = len(world.ha_services)
        clock.set(SLOT_START)
        for name, value in (("p_grid_forecast", 3795.27), ("p_batt_forecast", -3063.52)):
            world.set_state(f"sensor.{name}", value, updated=datetime(2026, 10, 9, 11, 15, tzinfo=UTC))
        prime(client, world)
        run = run_job(client, "inverter.decide")
        assert run["outcome"] == "ok", run
        assert run["summary"].startswith("Already set: 'Force charge' (rule force_charge): grid 18800 W"), run
        decision = client.get(f"/api/runs/{run['id']}/artifacts/decision").json()
        assert decision["source"] == "EMHASS sensors (sensor.p_*)"
        assert world.ha_services[written:] == []
    finally:
        client.__exit__(None, None, None)


FEEDIN = "number.sofar_feedin_max_power"
FEEDIN_BUTTON = "button.sofar_feedin_limitation_mode"


def block_export(client: TestClient, world: World, at_or_below: float) -> None:
    rev = client.get("/api/settings").json()["revision"]
    changes = {"emhass": {"mpc": {"no_export_at_or_below": at_or_below}}}
    assert client.patch("/api/settings", json={"base_revision": rev, "changes": changes}).status_code == 200
    prime(client, world)


def plan_slot(world: World, g: float, b: float, pv: float, c: float = 0.0) -> None:
    for name, value in (("p_grid", g), ("p_batt", b), ("p_pv", pv)):
        world.set_state(f"sensor.{name}_forecast", value)
    world.set_state("sensor.p_pv_curtailment", c)


def test_live_leaves_the_feedin_limit_alone_when_nothing_can_reach_the_grid(tmp_path: Path, world: World) -> None:
    plan_slot(world, 563, 87, 307)  # run 1817: importing at 08:15 with little PV
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        assert run_job(client, "emhass.mpc")["outcome"] == "ok"
        block_export(client, world, 1.0)  # every slot's export price is "cheap": the limit would be 0 W
        set_mode(client, world, "live")
        run = run_job(client, "inverter.decide")
        assert run["outcome"] == "ok", run
        assert settings(run["summary"]).endswith("feed-in unchanged"), run["summary"]
        decision = client.get(f"/api/runs/{run['id']}/artifacts/decision").json()["decision"]
        assert decision["feedin_max_w"] == 0 and decision["feedin_needed"] is False
        touched = [s[1].get("entity_id") for s in world.ha_services]
        assert FEEDIN not in touched and FEEDIN_BUTTON not in touched
        assert world.ha_states[FEEDIN]["state"] == "15500"
        readback = client.get(f"/api/runs/{run['id']}/artifacts/readback").json()
        assert readback["agree"] is True and "feedin_max_w" not in [f["field"] for f in readback["fields"]]
    finally:
        client.__exit__(None, None, None)


def test_live_writes_the_feedin_limit_when_the_plan_curtails_pv(tmp_path: Path, world: World) -> None:
    plan_slot(world, 0, 0, 5000, c=400)
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        assert run_job(client, "emhass.mpc")["outcome"] == "ok"
        block_export(client, world, 1.0)
        set_mode(client, world, "live")
        run = run_job(client, "inverter.decide")
        assert run["outcome"] == "ok", run
        assert settings(run["summary"]).endswith("feed-in 0 W (was 15500 W)"), run["summary"]
        touched = [s[1].get("entity_id") for s in world.ha_services]
        assert FEEDIN in touched and FEEDIN_BUTTON in touched
        assert float(world.ha_states[FEEDIN]["state"]) == 0
    finally:
        client.__exit__(None, None, None)


def test_the_summary_says_whether_the_feedin_limit_is_kept() -> None:
    targets = Targets("Force discharge", -15500, 20000, -20000)
    decision = Decision("force_discharge", "Force discharge", "why", targets, 15500, "export allowed")
    head = "'Force discharge' (rule force_discharge): grid -15500 W, battery -20000…20000 W, "

    def seen(feedin: float | None) -> Observed:
        return Observed("Self-use battery or PV", 0.0, 20000.0, -20000.0, feedin)

    assert describe(decision, seen(15500.0)) == head + "feed-in 15500 W (kept)"  # run 6727
    assert describe(decision, seen(0.0)) == head + "feed-in 15500 W (was 0 W)"
    assert describe(decision, seen(None)) == head + "feed-in 15500 W"  # the register isn't known
    assert describe(decision) == head + "feed-in 15500 W"
    left = Decision("self_use", "Self-use", "why", targets, 0, "left as it is", feedin_needed=False)
    assert describe(left, seen(15500.0)).endswith("feed-in unchanged")


def test_the_summary_ends_with_the_plans_battery_power() -> None:
    targets = Targets("Force charge", 5600, 20000, -3000)
    decision = Decision("force_charge", "Force charge", "why", targets, 0, "no export", p_batt_w=-3000.4)
    assert describe(decision).endswith("feed-in 0 W · P_batt -3000 W")


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


# --- the minute drift check ---------------------------------------------------------------------------------------

SLOT_START = datetime(2026, 10, 9, 11, 15, 10, tzinfo=UTC)
GRID = "number.sofar_passive_mode_grid_power"


def applied(tmp_path: Path, world: World) -> tuple[TestClient, FakeClock, int]:
    """Live, with this slot's targets written; returns the grid target."""
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    assert run_job(client, "emhass.mpc")["outcome"] == "ok"
    set_mode(client, world, "live")
    clock.set(SLOT_START)
    assert run_job(client, "inverter.decide")["outcome"] == "ok"
    prime(client, world)
    inverter = client.app.state.container.extras["inverter"]  # type: ignore[attr-defined]
    return client, clock, inverter.last_decision.targets.grid_power_w


def drift_runs(client: TestClient) -> list[dict]:
    """The decisions the drift check started, once none of them is still running."""
    for _ in ticks():
        runs = [r for r in client.get("/api/runs", params={"job": "inverter.decide"}).json() if r["trigger"] == "event"]
        if all(r["outcome"] != "running" for r in runs):
            return runs
    raise AssertionError("a drift correction never finished")


def drift_to(client: TestClient, world: World, value: float) -> None:
    world.set_state(GRID, value)
    prime(client, world)


def test_a_changed_register_is_set_back_after_it_is_seen_twice(tmp_path: Path, world: World) -> None:
    client, clock, target = applied(tmp_path, world)
    try:
        drift_to(client, world, target - 2600)
        run_job(client, "inverter.verify")
        assert drift_runs(client) == []  # just written: Home Assistant may still show the old value
        clock.advance(150)
        run_job(client, "inverter.verify")
        assert drift_runs(client) == []  # seen once
        clock.advance(60)
        run_job(client, "inverter.verify")
        [fixed] = drift_runs(client)
        assert fixed["outcome"] == "ok", fixed
        expected = f"Drift: grid power {target - 2600:g} W, expected {target} W; set back · Set "
        assert fixed["summary"].startswith(expected)
        assert float(world.ha_states[GRID]["state"]) == target
        status = client.get("/api/inverter").json()["drift"]
        assert status["enabled"] is True and status["corrections_1h"] == 1 and status["fighting"] is None
    finally:
        client.__exit__(None, None, None)


def test_a_feedin_limit_that_wasnt_written_is_not_drift(tmp_path: Path, world: World) -> None:
    plan_slot(world, 563, 87, 307)
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        assert run_job(client, "emhass.mpc")["outcome"] == "ok"
        block_export(client, world, 1.0)
        set_mode(client, world, "live")
        clock.set(SLOT_START)
        assert run_job(client, "inverter.decide")["outcome"] == "ok"
        world.set_state(FEEDIN, 8000)  # something else changed it; the slot doesn't need the limit
        prime(client, world)
        for _ in range(3):
            clock.advance(130)
            run_job(client, "inverter.verify")
        assert drift_runs(client) == []
        assert float(world.ha_states[FEEDIN]["state"]) == 8000
    finally:
        client.__exit__(None, None, None)


def test_a_feedin_limit_left_by_a_sell_session_is_kept_while_it_covers_the_plan(tmp_path: Path, world: World) -> None:
    world.set_state(FEEDIN, 3000)  # what a Kratt sell session left
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        assert run_job(client, "emhass.mpc")["outcome"] == "ok"
        set_mode(client, world, "live")
        clock.set(SLOT_START)
        published = datetime(2026, 10, 9, 11, 15, tzinfo=UTC)  # the plan exports 2770 W; export is never blocked
        for name, value in (("p_grid", -2770), ("p_batt", 0), ("p_pv", 3867)):
            world.set_state(f"sensor.{name}_forecast", value, updated=published)
        prime(client, world)
        run = run_job(client, "inverter.decide")
        assert run["outcome"] == "ok", run
        assert settings(run["summary"]).endswith("feed-in 3000 W (kept)"), run["summary"]  # no feed-in written
        decision = client.get(f"/api/runs/{run['id']}/artifacts/decision").json()["decision"]
        assert decision["feedin_floor_w"] == 2800 and "kept: 3000 W" in decision["feedin_why"]
        touched = [s[1].get("entity_id") for s in world.ha_services]
        assert FEEDIN not in touched and FEEDIN_BUTTON not in touched
        prime(client, world)

        world.set_state(FEEDIN, 3800)  # another session, still enough: not drift
        prime(client, world)
        for _ in range(3):
            clock.advance(130)
            run_job(client, "inverter.verify")
        assert drift_runs(client) == []

        world.set_state(FEEDIN, 2000)  # too low for the plan's export: set back to the export max
        prime(client, world)
        for _ in range(3):
            clock.advance(130)
            run_job(client, "inverter.verify")
        [fixed] = drift_runs(client)
        assert fixed["summary"].startswith("Drift: feed-in limit 2000 W, expected 3000 W; set back"), fixed
        assert settings(fixed["summary"]).endswith("feed-in 15500 W (was 2000 W)"), fixed
        assert float(world.ha_states[FEEDIN]["state"]) == 15500
    finally:
        client.__exit__(None, None, None)


def test_the_check_leaves_the_inverter_alone_when_it_isnt_ours(tmp_path: Path, world: World) -> None:
    client, clock, target = applied(tmp_path, world)
    try:
        world.set_state("input_boolean.emhass_automation", "off")  # e.g. an mFRR session took the inverter
        drift_to(client, world, target - 2600)
        for _ in range(3):
            clock.advance(130)
            run_job(client, "inverter.verify")
        assert drift_runs(client) == []
    finally:
        client.__exit__(None, None, None)


def test_something_that_keeps_changing_the_inverter_stops_the_corrections(tmp_path: Path, world: World) -> None:
    client, clock, target = applied(tmp_path, world)
    try:
        for _ in range(4):
            drift_to(client, world, target - 2600)
            clock.advance(125)
            run_job(client, "inverter.verify")
            clock.advance(60)
            run_job(client, "inverter.verify")
            drift_runs(client)  # let a correction finish before the register changes again
            prime(client, world)
        assert len(drift_runs(client)) == 3
        assert float(world.ha_states[GRID]["state"]) == target - 2600  # the fourth time it was left alone
        status = client.get("/api/inverter").json()["drift"]
        assert status["fighting"]["field"] == "grid power" and status["fighting"]["count"] == 3
        run_job(client, "health.evaluate")
        assert "inverter.fighting" in {p["key"] for p in client.get("/api/problems").json()["active"]}
    finally:
        client.__exit__(None, None, None)


# --- importing while discharging: the cap follows the plan within the slack -----------------------------------------

BMIN = "number.sofar_passive_mode_battery_power_min"


def plan_sensors(world: World, g: float, b: float, at: datetime) -> None:
    for name, value in (("p_grid_forecast", g), ("p_batt_forecast", b)):
        world.set_state(f"sensor.{name}", value, updated=at)


def test_back_to_back_discharge_slots_within_the_slack_write_nothing(tmp_path: Path, world: World) -> None:
    plan_slot(world, 2000, 1180, 0)  # the house 3 kW at night: the battery about 1.2 kW, the grid the rest
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        assert run_job(client, "emhass.mpc")["outcome"] == "ok"
        set_mode(client, world, "live")
        first = run_job(client, "inverter.decide")
        assert first["outcome"] == "ok", first
        assert "(rule use_bat_import): grid 0 W, battery -1500…20000 W" in first["summary"], first
        assert float(world.ha_states[BMIN]["state"]) == -1500
        written = len(world.ha_services)
        clock.set(SLOT_START)
        plan_sensors(world, 1740, 1260, datetime(2026, 10, 9, 11, 15, tzinfo=UTC))
        prime(client, world)
        run = run_job(client, "inverter.decide")
        assert run["outcome"] == "ok", run
        assert run["summary"].startswith(
            "Already set: 'Self-use battery or PV' (rule use_bat_import): grid 0 W, battery -1500…20000 W"
        ), run
        assert world.ha_services[written:] == []
        decision = client.get(f"/api/runs/{run['id']}/artifacts/decision").json()["decision"]
        assert decision["branch"] == "use_bat_import"
        assert "kept: within 500 W above the plan's 1260 W" in decision["why"]
    finally:
        client.__exit__(None, None, None)


def test_a_drifted_cap_is_set_back_even_within_the_slack(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        assert run_job(client, "emhass.mpc")["outcome"] == "ok"
        set_mode(client, world, "live")
        clock.set(SLOT_START)
        plan_sensors(world, 2000, 1180, datetime(2026, 10, 9, 11, 15, tzinfo=UTC))
        prime(client, world)
        assert run_job(client, "inverter.decide")["outcome"] == "ok"
        assert float(world.ha_states[BMIN]["state"]) == -1500
        world.set_state(BMIN, -1400)  # something else; still within the slack above the plan's 1180 W
        prime(client, world)
        run_job(client, "inverter.verify")
        clock.advance(150)
        run_job(client, "inverter.verify")
        clock.advance(60)
        run_job(client, "inverter.verify")
        [fixed] = drift_runs(client)
        assert fixed["outcome"] == "ok", fixed
        assert fixed["summary"].startswith("Drift: battery min -1400 W, expected -1500 W; set back · Set "), fixed
        assert float(world.ha_states[BMIN]["state"]) == -1500
    finally:
        client.__exit__(None, None, None)


APPLY_BUTTON = "button.sofar_passive_mode_battery_charge_discharge"
BY_AUTOMATION = {"id": "a", "parent_id": "t", "user_id": None}  # Home Assistant's context of the press
BY_USER = {"id": "b", "parent_id": None, "user_id": "u"}


def push_button(client: TestClient, world: World, entity: str, stamp: str, context: dict | None = None) -> None:
    """What the WebSocket delivers when a button is pressed: its state is the time of the press."""
    state = dict(world.set_state(entity, stamp), context=context or {})
    portal = client.portal
    assert portal is not None
    portal.call(client.app.state.container.extras["ha"]._set_state, entity, state)  # type: ignore[attr-defined]


def test_presses_say_who_pressed_the_buttons(tmp_path: Path, world: World) -> None:
    client = live_client(tmp_path, world, FakeClock(START))
    try:
        push_button(client, world, APPLY_BUTTON, "2026-10-09T09:00:00+00:00")  # as first seen: not a press
        push_button(client, world, FEEDIN_BUTTON, "2026-10-09T09:00:00+00:00")
        push_button(client, world, APPLY_BUTTON, "2026-10-09T11:05:00+00:00", BY_AUTOMATION)
        push_button(client, world, FEEDIN_BUTTON, "2026-10-09T11:06:00+00:00", BY_USER)
        push_button(client, world, FEEDIN_BUTTON, "2026-10-09T11:07:00+00:00")
        status = client.get("/api/inverter").json()
        assert [(p["at"], p["button"], p["source"], p["run_id"]) for p in status["presses"]] == [
            ("2026-10-09T11:07:00.000+00:00", "feedin", "unknown", None),
            ("2026-10-09T11:06:00.000+00:00", "feedin", "user", None),
            ("2026-10-09T11:05:00.000+00:00", "apply", "automation", None),
        ]
        wear = status["wear_24h"]
        assert (wear["apply_presses"], wear["feedin_presses"], wear["presses_not_ours"]) == (1, 2, 3)
        assert wear["last_feedin_at"] == "2026-10-09T11:07:00.000+00:00"
    finally:
        client.__exit__(None, None, None)


def test_a_press_by_emhass_lens_names_its_run(tmp_path: Path, world: World) -> None:
    client = live_client(tmp_path, world, FakeClock(START))
    try:
        assert run_job(client, "emhass.mpc")["outcome"] == "ok"
        set_mode(client, world, "live")
        push_button(client, world, APPLY_BUTTON, "2026-10-09T09:00:00+00:00")
        run = run_job(client, "inverter.decide")
        assert run["outcome"] == "ok", run
        pressed = world.ha_states[APPLY_BUTTON]["state"]
        # Home Assistant names the App's own user; the press is still ours, by the run that pressed it
        push_button(client, world, APPLY_BUTTON, pressed, {"id": "c", "parent_id": None, "user_id": "supervisor"})
        push_button(client, world, APPLY_BUTTON, "2026-10-09T11:14:00+00:00", BY_USER)
        presses = client.get("/api/inverter").json()["presses"]
        # and who the run wrote for: the plan (a market session's run says market)
        assert [(p["source"], p["run_id"], p["owner"]) for p in presses] == [
            ("user", None, None),
            ("lens", run["id"], "plan"),
        ]
        wear = client.get("/api/inverter").json()["wear_24h"]
        assert (wear["apply_presses"], wear["our_commits"], wear["presses_not_ours"]) == (2, 1, 1)
    finally:
        client.__exit__(None, None, None)


def test_the_activity_of_a_window_has_its_presses_and_writes(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        assert run_job(client, "emhass.mpc")["outcome"] == "ok"
        set_mode(client, world, "live")
        push_button(client, world, APPLY_BUTTON, "2026-10-09T09:00:00+00:00")  # as first seen: not a press
        run = run_job(client, "inverter.decide")
        assert run["outcome"] == "ok", run
        pressed = world.ha_states[APPLY_BUTTON]["state"]
        push_button(client, world, APPLY_BUTTON, pressed, {"id": "c", "parent_id": None, "user_id": "supervisor"})
        push_button(client, world, APPLY_BUTTON, "2026-10-09T11:14:00+00:00", BY_USER)
        day = {"since": "2026-10-08T21:00:00Z", "until": "2026-10-09T21:00:00Z"}
        activity = client.get("/api/inverter/activity", params=day).json()
        assert [w["run_id"] for w in activity["writes"]] == [run["id"]]
        assert [p["source"] for p in activity["presses"]] == ["user", "lens"]  # newest first
        # a window that ends before them has none; until defaults to now
        before = client.get("/api/inverter/activity", params={"since": day["since"], "until": "2026-10-09T10:00:00Z"})
        assert before.json() == {"presses": [], "writes": []}
        clock.advance(seconds=120)
        since = client.get("/api/inverter/activity", params={"since": "2026-10-09T11:13:30Z"}).json()
        assert ([p["source"] for p in since["presses"]], since["writes"]) == (["user"], [])
        # at most 8 days, and since before until
        long = client.get("/api/inverter/activity", params={"since": "2026-09-30T00:00:00Z", "until": day["until"]})
        assert long.status_code == 400
        backwards = client.get("/api/inverter/activity", params={"since": day["until"], "until": day["since"]})
        assert backwards.status_code == 400
    finally:
        client.__exit__(None, None, None)


def test_presses_recorded_before_the_source_was_kept_are_ours_next_to_a_commit(app_db) -> None:
    app_db.execute("ALTER TABLE sofar_press DROP COLUMN source")
    app_db.execute("ALTER TABLE sofar_press DROP COLUMN run_id")
    app_db.execute("PRAGMA user_version = 5")
    app_db.execute(
        "INSERT INTO sofar_commit (at, owner, register_group)"
        " VALUES ('2026-10-09T11:00:01.000+00:00', 'plan', 'passive')"
    )
    app_db.execute(
        "INSERT INTO sofar_commit (at, owner, register_group, ok)"
        " VALUES ('2026-10-09T12:00:01.000+00:00', 'plan', 'passive', 0)"
    )
    for at in ("2026-10-09T11:00:00.500+00:00", "2026-10-09T11:05:00.000+00:00", "2026-10-09T12:00:00.000+00:00"):
        app_db.execute("INSERT INTO sofar_press (at, entity_id) VALUES (?, ?)", (at, APPLY_BUTTON))
    app_db.migrate()
    rows = app_db.query("SELECT at, source FROM sofar_press ORDER BY at")
    assert [r["source"] for r in rows] == ["lens", "unknown", "unknown"]
