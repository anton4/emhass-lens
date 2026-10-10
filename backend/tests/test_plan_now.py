"""The Plan page's this slot: the row in force, what is measured now, and the inverter's settings."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

from emhass_lens.core.clock import FakeClock
from emhass_lens.domain.plan_now import Reading, compare, power_differs, row_for, soc_expected
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
    assert [got[k]["differs"] for k in ("batt", "grid", "pv", "load", "soc")] == [True, True, False, None, False]
    assert got["batt"]["entity"] == "sensor.batt" and got["batt"]["age_s"] == 20.0
    assert got["soc"]["plan"] == 0.92 and round(got["soc"]["expected"], 4) == 0.9236


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
        world.set_state("sensor.batt_w", row["P_batt"] + 1500)
        world.set_state("sensor.grid_w", row["P_grid"])
        prime(client, world)

        now = client.get("/api/plan/now").json()
        assert now["slot_start"] == "2026-10-09T11:15:00.000+00:00"
        assert now["row"]["timestamp"] == row["timestamp"] and now["plan_run_id"] is not None
        quantities = {q["key"]: q for q in now["quantities"]}
        assert quantities["batt"]["differs"] is True and quantities["batt"]["entity"] == "sensor.batt_w"
        assert quantities["grid"]["differs"] is False
        assert quantities["pv"]["measured"] is None or quantities["pv"]["entity"] == "sensor.sofar_pv_power_total_watt"
        inverter = now["inverter"]
        assert inverter["mode"] == "live" and inverter["in_control"] is True
        assert inverter["charger_mode"] == "Passive Mode" and inverter["written_at"] is not None
        assert now["next_start"] == "2026-10-09T11:30:00.000+00:00"
        assert now["next_row"] is not None
    finally:
        client.__exit__(None, None, None)
