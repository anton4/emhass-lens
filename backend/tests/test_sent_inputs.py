"""The Inputs page's "What EMHASS gets": one payload slot by slot (GET /api/inputs/sent, POST …/preview)."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from emhass_lens.core.clock import FakeClock
from emhass_lens.domain.mpc.sent import deferrables, load_series
from tests.test_phase1 import make_client, prime, run_job
from tests.test_phase2 import START, live_client
from tests.world import TZ, World

T0 = datetime(2026, 10, 11, 18, 0, tzinfo=UTC)
STARTS = [T0 + timedelta(minutes=15 * i) for i in range(4)]


def test_the_load_comes_from_the_plan_on_the_same_slots() -> None:
    rows = [
        # EMHASS writes local times; one slot before the anchor and one missing
        {"timestamp": "2026-10-11T20:45:00+03:00", "P_Load": 900.0},
        {"timestamp": "2026-10-11T21:00:00+03:00", "P_Load": 1991.0},
        {"timestamp": "2026-10-11T21:15:00+03:00", "P_Load": 841.6},
        {"timestamp": "2026-10-11T21:45:00+03:00", "P_Load": "1270"},
    ]
    assert load_series({}, STARTS, rows) == ("plan", [1991.0, 841.6, None, 1270.0])


def test_a_load_forecast_in_the_payload_wins_over_the_plan() -> None:
    payload = {"load_power_forecast": [1500, 1600]}
    assert load_series(payload, STARTS, [{"timestamp": T0.isoformat(), "P_Load": 1.0}]) == (
        "sent",
        [1500.0, 1600.0, None, None],
    )


def test_no_plan_on_these_slots_is_no_load() -> None:
    assert load_series({}, STARTS, None) == ("none", [None] * 4)
    assert load_series({}, STARTS, [{"timestamp": "2026-10-01T00:00:00Z", "P_Load": 1.0}])[0] == "none"


def test_a_load_that_is_off_shows_what_it_would_ask_for() -> None:
    payload = {
        "number_of_deferrable_loads": 1,
        "nominal_power_of_deferrable_loads": [0],
        "operating_hours_of_each_deferrable_load": [0.0],
        "end_timesteps_of_each_deferrable_load": [0],
        "set_deferrable_load_single_constant": [True],
    }
    described = [
        {
            "name": "EV",
            "nominal_power_w": 11000,
            "enabled": {"value": False, "source": "input_boolean.ev_charging_enabled"},
            "operating_hours": {"value": 0.45},
            "deadline_timesteps": {"value": 6.0},
        }
    ]
    assert deferrables(payload, described) == [
        {
            "name": "EV",
            "on": False,
            "nominal_power_w": 0.0,
            "operating_hours": 0.0,
            "end_timesteps": 0,
            "single_constant": True,
            "configured_power_w": 11000.0,
            "configured_hours": 0.45,
            "configured_end_timesteps": 6,
            "enabled_source": "input_boolean.ev_charging_enabled",
        }
    ]


def test_a_load_without_a_description_is_named_by_its_position() -> None:
    payload = {"number_of_deferrable_loads": 1, "nominal_power_of_deferrable_loads": [3000]}
    [row] = deferrables(payload, [])
    assert (row["name"], row["on"], row["nominal_power_w"], row["end_timesteps"]) == ("Load 1", True, 3000.0, 0)


@pytest.fixture
def world() -> World:
    w = World()
    w.standard_entities(datetime(2026, 10, 9, tzinfo=TZ))
    w.set_state("switch.nordpool_ee_prices_emhass_auto_mpc", "off")
    return w


def test_the_last_run_slot_by_slot_with_the_plans_load(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        container = client.app.state.container  # type: ignore[attr-defined]
        # a measured house load an hour before the anchor (11:15)
        container.app_db.execute(
            "INSERT INTO measurement (slot_utc, quantity, value, coverage, entity_id) VALUES (?,?,?,?,?)",
            ("2026-10-09T10:15:00.000+00:00", "load", 1234.0, 1.0, "sensor.house_power_without_deferrable"),
        )
        run = run_job(client, "emhass.mpc")
        assert run["outcome"] == "ok", run
        [(_, payload)] = [a for a in world.emhass_actions if a[0] == "naive-mpc-optim"]

        body = client.get("/api/inputs/sent", params={"hours_back": 2}).json()
        assert body["available"] and body["source"] == "last_run"
        assert (body["run_id"], body["run_outcome"], body["run_mode"]) == (run["id"], "ok", "live")
        assert body["anchor"] == "2026-10-09T11:15:00.000+00:00"
        assert [s["load_cost"] for s in body["slots"]] == payload["load_cost_forecast"]
        assert [s["pv_w"] for s in body["slots"]] == payload["pv_power_forecast"]
        # the plan this run made carries the house load EMHASS forecast
        assert body["load_source"] == "plan" and body["load_plan_run_id"] == run["id"]
        assert body["load_w"] == [1500.0] * len(body["slots"])
        assert body["soc_init"] == 0.62 and body["soc_init_reading"]["value"] == 0.62
        assert body["model"]["method"] == "mlforecaster"
        assert body["model"]["var_model"] == payload["var_model"]
        assert len(body["measured"]) == 8
        assert body["measured"][0]["start"] == "2026-10-09T09:15:00.000+00:00"
        slot = {"start": "2026-10-09T10:15:00.000+00:00", "load": 1234.0, "pv": None, "soc": None}
        assert body["measured"][4] == slot
        assert body["measured_entities"]["load"] == "sensor.house_power_without_deferrable"
    finally:
        client.__exit__(None, None, None)


def test_without_an_mpc_run_there_is_nothing_sent_but_a_preview_builds_one(tmp_path: Path, world: World) -> None:
    clock = FakeClock(datetime(2026, 10, 9, 11, 5, tzinfo=UTC))
    with make_client(tmp_path, world, clock) as client:
        run_job(client, "nordpool.poll")
        prime(client, world)
        body = client.get("/api/inputs/sent").json()
        assert not body["available"] and body["slots"] == []

        built = client.post("/api/inputs/sent/preview", params={"hours_back": 0}).json()
        assert built["available"] and built["source"] == "preview" and built["run_id"] is None
        assert built["anchor"] == "2026-10-09T11:00:00.000+00:00"
        assert len(built["slots"]) > 0 and built["measured"] == []
        assert built["load_source"] == "none" and all(v is None for v in built["load_w"])
