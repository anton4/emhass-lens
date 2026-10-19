"""The Plan page's this slot: the row in force, what is measured now, and the inverter's settings."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

from emhass_lens.core.clock import FakeClock
from emhass_lens.domain.inverter import Targets
from emhass_lens.domain.plan_now import (
    Reading,
    battery_expected,
    compare,
    inverter_expected,
    net_demand,
    planned_slots,
    power_differs,
    row_for,
    row_targets,
    soc_expected,
)
from emhass_lens.settings.model import InverterLimits
from tests.test_inverter_service import set_mode
from tests.test_inverter_service import world as inverter_world  # noqa: F401  (fixture)
from tests.test_phase1 import prime, run_job
from tests.test_phase2 import live_client
from tests.world import World

T = datetime(2026, 10, 10, 14, 30, tzinfo=UTC)


def plan(generated: str, start: datetime, n: int, batt: float = 1680.0) -> dict:
    rows = [
        {
            "timestamp": (start + timedelta(minutes=15 * i)).isoformat(),
            "P_batt": batt,
            "P_grid": 0.0,
            "P_PV": 314.0,
            "P_Load": 1940.0,
            "SOC_opt": 0.92 - 0.004 * i,
        }
        for i in range(n)
    ]
    return {"generated_at": generated, "plan": rows}


def test_the_row_in_force_is_the_newest_plan_that_has_the_slot() -> None:
    newest = plan("14:28", T + timedelta(minutes=15), 4)  # made during the slot: starts at the next one
    in_force = plan("14:13", T, 4, batt=-500.0)
    older = plan("13:58", T - timedelta(minutes=15), 4, batt=999.0)
    found = row_for([newest, in_force, older], T)
    assert found is not None and found[0] is in_force and found[1]["P_batt"] == -500.0 and found[2] == 0
    nxt = row_for([newest, in_force, older], T + timedelta(minutes=15))
    assert nxt is not None and nxt[0] is newest
    assert row_for([newest], T) is None


def test_what_counts_as_different() -> None:
    assert power_differs(1680, 120) is True  # the owner's 17:30 slot
    assert power_differs(1940, 2030) is False  # 90 W off
    assert power_differs(5000, 5600) is False  # 600 W, but only 11 %
    assert power_differs(0, 250) is False
    assert power_differs(None, 100) is None
    assert soc_expected(0.92, 0.914, 0.5) == 0.917
    assert soc_expected(None, 0.914, 0.5) == 0.914
    assert soc_expected(0.92, None, 0.5) is None


def test_compare_lists_every_quantity_with_its_reading() -> None:
    row = plan("x", T, 1)["plan"][0]
    prev = {"SOC_opt": 0.924}
    measured = {
        "batt": Reading(120.0, "sensor.batt", 20.0),
        "grid": Reading(1790.0, "sensor.grid", 20.0),
        "pv": Reading(312.0, "sensor.pv", 8.0),
        "load": Reading(None, None, None),
        "soc": Reading(0.923, "sensor.soc", 60.0),
    }
    got = {q["key"]: q for q in compare(row, prev, measured, fraction=0.1)}
    # house load and PV are forecasts: shown, not judged
    assert [got[k]["differs"] for k in ("batt", "grid", "pv", "load", "soc")] == [True, True, None, None, False]
    assert got["batt"]["entity"] == "sensor.batt" and got["batt"]["age_s"] == 20.0
    assert got["soc"]["plan"] == 0.92 and round(got["soc"]["expected"], 4) == 0.9236


def test_the_battery_is_judged_against_the_plan_for_the_load_and_pv_now() -> None:
    """The owner's 18:15 slot: plan 1.57 kW discharge for a 1.54 kW house load; the house used 698 W."""
    row = {"P_batt": 1570.0, "P_grid": 0.0, "P_PV": 16.0, "P_Load": 1540.0, "P_deferrable0": 0.0, "SOC_opt": 0.904}

    def measured(batt: float) -> dict[str, Reading]:
        return {
            "batt": Reading(batt, "sensor.batt", 20.0),
            "grid": Reading(34.0, "sensor.grid", 20.0),
            "pv": Reading(0.0, "sensor.pv", 8.0),
            "load": Reading(698.0, "sensor.load", 8.0),
            "soc": Reading(0.91, "sensor.soc", 60.0),
        }

    right = {q["key"]: q for q in compare(row, None, measured(720.0), 0.5)}
    assert right["batt"]["expected"] == 1570 - (1540 - 698) + 16  # 744 W
    assert right["batt"]["differs"] is False and right["batt"]["sign_hint"] is False
    assert right["load"]["differs"] is None and right["pv"]["differs"] is None
    wrong_sign = {q["key"]: q for q in compare(row, None, measured(-720.0), 0.5)}
    assert wrong_sign["batt"]["differs"] is True and wrong_sign["batt"]["sign_hint"] is True
    # the EV charges 5.5 kW the plan didn't have: the battery is expected to cover that too
    assert battery_expected(row, measured(0.0), deferrable_now=5520.0) == 744 + 5520
    assert battery_expected(row, {}, None) == 1570  # nothing measured: the plan as it is


def readings(**values: float | None) -> dict[str, Reading]:
    return {k: Reading(v, f"sensor.{k}", 10.0) for k, v in values.items()}


# The owner's 11:30 slot on 13 Oct: PV export (grid target 0 W, the battery may discharge but not charge)
PV_EXPORT = Targets("Self-use PV and export excess to grid", 0, 0, -20000)
PV_EXPORT_ROW = {
    "P_batt": 0.0,
    "P_grid": -2920.0,
    "P_PV": 4410.0,
    "P_Load": 1350.0,
    "P_deferrable0": 0.0,
    "P_PV_curtailment": 0.0,
    "unit_prod_price": 0.1858,
    "SOC_opt": 0.88,
}


def test_more_pv_than_forecast_goes_to_the_grid_when_the_battery_may_not_charge() -> None:
    """Measured 5.00 kW PV, 558 W house, grid -4.25 kW, battery 0 W: the extra PV is exported, as it should be."""
    measured = readings(pv=5000.0, load=558.0, grid=-4250.0, batt=0.0, soc=0.87)
    got = {q["key"]: q for q in compare(PV_EXPORT_ROW, None, measured, 0.5, 0.0, PV_EXPORT, (20000.0, 20000.0))}
    assert got["batt"]["expected"] == 0 and got["batt"]["differs"] is False
    assert got["grid"]["expected"] == 558 - 5000 and got["grid"]["differs"] is False
    # without the inverter's settings the battery was expected to take the PV, and both were flagged
    old = {q["key"]: q for q in compare(PV_EXPORT_ROW, None, measured, 0.5, 0.0)}
    assert old["batt"]["differs"] is True and old["grid"]["differs"] is True and old["grid"]["expected"] is None


def test_less_pv_than_the_house_needs_comes_from_the_battery_in_pv_export() -> None:
    """A cloud: the grid target is 0 W, so the battery covers what the PV doesn't and nothing is imported."""
    measured = readings(pv=400.0, load=1300.0)
    assert inverter_expected(net_demand(PV_EXPORT_ROW, measured, None) or 0.0, PV_EXPORT) == (900.0, 0.0)
    # with some PV to spare it is exported and the battery stays idle
    assert inverter_expected(-1200.0, PV_EXPORT) == (0.0, -1200.0)


def test_a_force_discharge_holds_the_grid_and_the_battery_takes_the_difference() -> None:
    """The owner's 11:15 slot: grid target -15.5 kW; PV 5.20 kW, house 2.60 kW, battery 13.16 kW."""
    row = {"P_batt": 13140.0, "P_grid": -15500.0, "P_PV": 4130.0, "P_Load": 1250.0, "unit_prod_price": 0.2194}
    targets = Targets("Self-use battery or PV", -15500, 20000, -20000)
    measured = readings(pv=5200.0, load=2600.0, grid=-15490.0, batt=13160.0)
    got = {q["key"]: q for q in compare(row, None, measured, 0.5, None, targets)}
    assert got["batt"]["expected"] == 2600 - 5200 + 15500 and got["batt"]["differs"] is False
    assert got["grid"]["expected"] == -15500 and got["grid"]["differs"] is False


def test_a_force_charge_at_the_import_max_is_held_to_what_the_battery_takes() -> None:
    targets = Targets("Force charge", 17000, 20000, -20000)
    assert inverter_expected(1000.0, targets) == (-16000.0, 17000.0)
    assert inverter_expected(1000.0, targets, (10000.0, 20000.0)) == (-10000.0, 11000.0)


def test_the_rules_give_a_plan_row_its_passive_settings() -> None:
    limits = InverterLimits()
    targets = row_targets(PV_EXPORT_ROW, limits, 0.04)
    assert targets is not None
    assert (targets.grid_power_w, targets.battery_max_w, targets.battery_min_w) == (0, 0, limits.battery_min_w)
    assert row_targets({"P_PV": 100.0}, limits, None) is None


def test_the_planned_modes_follow_the_plan_rows_after_the_slot_in_force() -> None:
    limits = InverterLimits()
    at = lambda hhmm: f"2026-10-09T{hhmm}:00+00:00"  # noqa: E731
    charge = {"P_batt": -3000.0, "P_grid": 5600.0, "P_PV": 0.0, "unit_prod_price": 0.02}
    rows = [
        {**charge, "timestamp": at("11:00")},  # the slot in force: left out
        {**PV_EXPORT_ROW, "timestamp": at("11:30")},
        {**charge, "timestamp": at("11:15")},
        {"P_PV": 100.0, "timestamp": at("11:45")},  # no P_batt or P_grid
        {**charge},  # no timestamp
    ]
    slots = planned_slots(rows, datetime(2026, 10, 9, 11, 0, tzinfo=UTC), limits, 0.04)
    assert [(s["slot"], s["state"], s["rule"]) for s in slots] == [
        ("2026-10-09T11:15:00.000+00:00", "Force charge", "force_charge"),
        ("2026-10-09T11:30:00.000+00:00", "Self-use PV and export excess to grid", "self_use_pv_export"),
    ]
    assert slots[0]["p_batt_w"] == -3000.0 and slots[0]["grid_power_w"] == 18800  # force charge holds the import max
    assert slots[1]["feedin_max_w"] is not None  # export allowed: the limit is part of the plan


def test_the_endpoint_shows_the_slot_in_force_with_measured_and_inverter_values(
    tmp_path: Path,
    inverter_world: World,  # noqa: F811
) -> None:
    world = inverter_world
    clock = FakeClock(datetime(2026, 10, 9, 11, 13, 0, tzinfo=UTC))
    measurements = {"battery": {"entity": "sensor.batt_w"}, "grid": {"entity": "sensor.grid_w"}}
    client = live_client(tmp_path, world, clock, measurements=measurements)
    try:
        assert run_job(client, "emhass.mpc")["outcome"] == "ok"  # anchored at 11:15
        set_mode(client, world, "live")
        clock.set(datetime(2026, 10, 9, 11, 16, 0, tzinfo=UTC))
        assert run_job(client, "inverter.decide")["outcome"] == "ok"
        row = client.get("/api/plan").json()["current"]["rows"][0]
        # the plan charges 3 kW with 2 kW from the grid: a Force charge, whose grid target is the import max, so the
        # inverter imports that and the battery takes all it can (20 kW, less the 1 kW the house is short of PV)
        import_max = InverterLimits().grid_import_max_w
        world.set_state("sensor.batt_w", row["P_batt"] + 1500)
        world.set_state("sensor.grid_w", import_max)
        prime(client, world)

        now = client.get("/api/plan/now").json()
        assert now["slot_start"] == "2026-10-09T11:15:00.000+00:00"
        assert now["row"]["timestamp"] == row["timestamp"] and now["plan_run_id"] is not None
        quantities = {q["key"]: q for q in now["quantities"]}
        assert quantities["batt"]["differs"] is True and quantities["batt"]["entity"] == "sensor.batt_w"
        assert quantities["batt"]["expected"] == row["P_Load"] - row["P_PV"] - import_max
        assert quantities["grid"]["expected"] == import_max and quantities["grid"]["differs"] is False
        assert quantities["pv"]["measured"] is None or quantities["pv"]["entity"] == "sensor.sofar_pv_power_total_watt"
        inverter = now["inverter"]
        assert inverter["mode"] == "live" and inverter["in_control"] is True
        assert inverter["charger_mode"] == "Passive Mode" and inverter["written_at"] is not None
        assert now["next_start"] == "2026-10-09T11:30:00.000+00:00"
        assert (now["soc_min"], now["soc_max"]) == (0.05, 1.0)  # EMHASS's config (fixtures/emhass)
        assert now["next_row"] is not None
        assert now["prev_start"] == "2026-10-09T11:00:00.000+00:00"

        # a slot on, 11:15 is the previous slot: its plan row against the quarter-hour means stored for it
        clock.set(datetime(2026, 10, 9, 11, 31, 0, tzinfo=UTC))
        container = client.app.state.container  # type: ignore[attr-defined]
        container.app_db.executemany(
            "INSERT OR REPLACE INTO measurement (slot_utc, quantity, value, coverage, entity_id) VALUES (?,?,?,?,?)",
            [
                ("2026-10-09T11:15:00.000+00:00", "batt", row["P_batt"] + 1500, 1.0, "sensor.batt_w"),
                ("2026-10-09T11:15:00.000+00:00", "grid", import_max, 1.0, "sensor.grid_w"),
            ],
        )
        before = client.get("/api/plan/now").json()
        assert before["prev_start"] == "2026-10-09T11:15:00.000+00:00"
        assert before["prev_row"]["timestamp"] == row["timestamp"]
        ended = {q["key"]: q for q in before["prev_quantities"]}
        assert ended["batt"]["measured"] == row["P_batt"] + 1500 and ended["batt"]["differs"] is True
        assert ended["grid"]["differs"] is False and ended["grid"]["entity"] == "sensor.grid_w"
        assert ended["grid"]["expected"] == import_max  # no registers kept: what the rules gave the row
        assert ended["load"]["measured"] is None and ended["batt"]["age_s"] is None
    finally:
        client.__exit__(None, None, None)


def control_container(market: object = None, external: object = None, states: dict | None = None) -> object:
    from types import SimpleNamespace

    from emhass_lens.settings.model import Settings

    ha = SimpleNamespace(state=lambda entity: (states or {}).get(entity))
    return SimpleNamespace(
        extras={"market": market, "external": external, "ha": ha},
        settings=SimpleNamespace(current=Settings()),
    )


def test_the_apps_own_market_session_drives_the_inverter() -> None:
    from types import SimpleNamespace

    from emhass_lens.services.market import Session
    from emhass_lens.services.plan_now import control_now

    session = Session(7, "sell", "kratt", "sell", 5000, T, T)
    market = SimpleNamespace(active=lambda: True, holds_inverter=lambda: True, session=session)
    external = SimpleNamespace(enabled=lambda: False, busy=False)
    assert control_now(control_container(market, external)) == {  # type: ignore[arg-type]
        "mode": "market",
        "run_by": "app",
        "value": "sell",
        "power_w": 5000,
        "source": "kratt",
        "since": "2026-10-10T14:30:00.000+00:00",
        "watched": True,
    }


def test_without_market_control_or_a_hold_the_plan_drives_but_sessions_are_not_watched() -> None:
    from types import SimpleNamespace

    from emhass_lens.services.plan_now import control_now

    market = SimpleNamespace(active=lambda: False, holds_inverter=lambda: False, session=None)
    external = SimpleNamespace(enabled=lambda: False, busy=False)
    assert control_now(control_container(market, external)) == {"mode": "emhass", "watched": False}  # type: ignore[arg-type]
    assert control_now(control_container()) == {"mode": "emhass", "watched": False}  # type: ignore[arg-type]
