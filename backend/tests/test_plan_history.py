"""Measurements from the recorder and the Plan page's history and accuracy (GET /api/plan/history)."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from emhass_lens.core.clock import FakeClock
from tests.test_phase1 import make_client, prime, run_job
from tests.world import World, make_plan

LOAD = "sensor.house_power_without_deferrable"
SOC = "sensor.ev6_battery_soc"
PV = "sensor.sofar_pv_power_total_watt"
NOW = datetime(2026, 10, 9, 11, 0, 20, tzinfo=UTC)  # 20 s after 11:00: the 10:45 slot just ended


@pytest.fixture
def world() -> World:
    w = World()
    w.standard_entities(datetime(2026, 10, 9, tzinfo=UTC))
    w.set_state(LOAD, 1500, {"unit_of_measurement": "W"})
    w.set_state(PV, 0, {"unit_of_measurement": "W"})
    since = NOW - timedelta(days=3)
    w.ha_history[LOAD] = [(since, "1500")]
    w.ha_history[SOC] = [(since, "60"), (datetime(2026, 10, 9, 10, 50, tzinfo=UTC), "62")]
    return w


def configure(client: TestClient, **measurements) -> None:
    rev = client.get("/api/settings").json()["revision"]
    changes = {"measurements": {"pv": {"entity": ""}, "backfill_days": 1, **measurements}}
    saved = client.patch("/api/settings", json={"base_revision": rev, "changes": changes})
    assert saved.status_code == 200, saved.text


def store_plan(client: TestClient, made_at: datetime, load_w: float = 1500.0) -> None:
    """Store a plan the way the plan watch does, as if EMHASS made it at `made_at`."""
    container = client.app.state.container  # type: ignore[attr-defined]
    payload = {
        "load_cost_forecast": [0.1] * 8,
        "prod_price_forecast": [0.05] * 8,
        "pv_power_forecast": [0.0] * 8,
        "soc_init": 0.6,
    }
    plan = make_plan(made_at, payload)
    for row in plan["plan"]:
        row["P_Load"] = load_w
    ok = container.extras["emhass"]._store_plan(plan["generated_at"], "app", None, {"status": "ok"}, plan)
    assert ok


def test_sample_stores_time_weighted_slot_means_in_emhass_units(tmp_path: Path, world: World) -> None:
    clock = FakeClock(NOW)
    with make_client(tmp_path, world, clock) as client:
        configure(client)
        prime(client, world)
        run = run_job(client, "measure.sample")
        assert run["outcome"] == "ok", run
        assert run["summary"].startswith("Slot 13:45: 2 of 2 quantities")
        (start, end, ids) = world.history_calls[-1]
        assert (start, end) == (datetime(2026, 10, 9, 10, 45, tzinfo=UTC), datetime(2026, 10, 9, 11, 0, tzinfo=UTC))
        assert ids == sorted([LOAD, SOC])
        container = client.app.state.container  # type: ignore[attr-defined]
        rows = container.app_db.query("SELECT quantity, value, coverage FROM measurement ORDER BY quantity")
        by = {r["quantity"]: r for r in rows}
        assert by["load"]["value"] == 1500.0 and by["load"]["coverage"] == 1.0
        # 5 minutes at 60 %, 10 minutes at 62 %, times the 0.01 scale
        assert abs(by["soc"]["value"] - (60 * 300 + 62 * 600) / 900 / 100) < 1e-9


def test_backfill_reads_older_history_in_chunks_until_the_range_is_covered(tmp_path: Path, world: World) -> None:
    clock = FakeClock(NOW)
    with make_client(tmp_path, world, clock) as client:
        configure(client)
        prime(client, world)
        outcomes = []
        run: dict = {}
        for _ in range(8):
            run = run_job(client, "measure.backfill")
            outcomes.append(run["outcome"])
            if run["outcome"] == "noop":
                break
        # one day = 96 slots = four six-hour chunks, then "complete"
        assert outcomes == ["ok", "ok", "ok", "ok", "noop"], outcomes
        assert run["summary"] == "History is complete"
        spans = [(e - s) for s, e, _ in world.history_calls]
        assert all(span <= timedelta(hours=6) for span in spans)
        assert world.history_calls[0][1] == datetime(2026, 10, 9, 11, 0, tzinfo=UTC)  # newest chunk first
        container = client.app.state.container  # type: ignore[attr-defined]
        count = container.app_db.query_one("SELECT count(*) AS n FROM measurement WHERE quantity = 'load'")
        assert count is not None and count["n"] == 96
        # a settings change starts over
        configure(client, soc={"entity": SOC, "scale": 0.01, "invert": False}, load={"entity": LOAD, "scale": 1000})
        run = run_job(client, "measure.backfill")
        assert run["outcome"] == "ok" and "to go" in run["summary"]


def test_plan_history_compares_the_plan_in_force_with_what_was_measured(tmp_path: Path, world: World) -> None:
    clock = FakeClock(NOW)
    with make_client(tmp_path, world, clock) as client:
        configure(client)
        prime(client, world)
        for _ in range(5):
            if run_job(client, "measure.backfill")["outcome"] == "noop":
                break
        # three plans: 09:58 (anchored 10:00), 10:13 (10:15) and 10:28 (10:30); the last one says 1700 W
        store_plan(client, datetime(2026, 10, 9, 9, 58, tzinfo=UTC))
        store_plan(client, datetime(2026, 10, 9, 10, 13, tzinfo=UTC))
        store_plan(client, datetime(2026, 10, 9, 10, 28, tzinfo=UTC), load_w=1700.0)

        body = client.get("/api/plan/history?hours=2&horizon=0").json()
        assert body["hours"] == 2 and body["horizon"] == 0
        slots = {s["start"]: s for s in body["slots"]}
        assert len(slots) == 8
        s1015 = slots["2026-10-09T10:15:00.000+00:00"]
        s1030 = slots["2026-10-09T10:30:00.000+00:00"]
        s1045 = slots["2026-10-09T10:45:00.000+00:00"]
        assert s1015["planned"]["P_Load"] == 1500.0 and s1015["planned_at"] == "2026-10-09T10:13:00.000+00:00"
        assert s1030["planned"]["P_Load"] == 1700.0  # the plan made at 10:28 is in force at 10:30
        assert s1045["planned"]["P_Load"] == 1700.0  # and still at 10:45 (no newer plan)
        assert s1045["actual"]["load"] == 1500.0
        assert abs(s1045["actual"]["soc"] - 0.61333) < 1e-4
        assert slots["2026-10-09T09:15:00.000+00:00"]["planned"]["P_Load"] is None  # before the first plan
        assert s1030["planned"]["SOC"] is not None

        [day, week] = body["accuracy"]
        assert day["hours"] == 24 and week["hours"] == 168
        load = next(q for q in day["quantities"] if q["quantity"] == "load")
        assert load["n"] == 4  # 10:00, 10:15, 10:30, 10:45 have both a plan and a measurement
        assert load["mae"] == 100.0 and load["bias"] == 100.0  # two slots planned 200 W too high
        assert load["unit"] == "W" and load["mape"] is not None
        soc = next(q for q in day["quantities"] if q["quantity"] == "soc")
        assert soc["unit"] == "%" and soc["n"] == 4
        grid = next(q for q in day["quantities"] if q["quantity"] == "grid")
        assert grid["n"] == 0 and grid["sign_suspect"] is False  # no grid sensor configured

        assert body["measurements"]["backfill_remaining_slots"] == 0
        assert {q["quantity"] for q in body["measurements"]["configured"]} == {"load", "soc"}
        assert body["prices"] == [] or body["prices"][0]["start"] >= "2026-10-09T09:00:00"

        # one hour of look-ahead: by 09:30 and 09:45 no plan existed yet (the first came at 09:58)
        ahead = client.get("/api/plan/history?hours=2&horizon=4").json()
        slots = {s["start"]: s for s in ahead["slots"]}
        assert slots["2026-10-09T10:30:00.000+00:00"]["planned"]["P_Load"] is None
        assert slots["2026-10-09T10:45:00.000+00:00"]["planned"]["P_Load"] is None
        assert ahead["accuracy"][0]["horizon"] == 4


def test_plan_rows_are_indexed_for_plans_stored_before_the_table_existed(tmp_path: Path, world: World) -> None:
    clock = FakeClock(NOW)
    with make_client(tmp_path, world, clock) as client:
        container = client.app.state.container  # type: ignore[attr-defined]
        store_plan(client, datetime(2026, 10, 9, 10, 28, tzinfo=UTC))
        container.app_db.execute("DELETE FROM plan_row")
        assert container.extras["emhass"].index_plan_rows(clock.now()) == 1
        assert container.extras["emhass"].index_plan_rows(clock.now()) == 0
        n = container.app_db.query_one("SELECT count(*) AS n FROM plan_row")
        assert n is not None and n["n"] == 8
        # pruning plans takes their rows along, and old rows go on their own
        container.extras["emhass"].prune(keep=0, now=clock.now())
        n = container.app_db.query_one("SELECT count(*) AS n FROM plan_row")
        assert n is not None and n["n"] == 0


def test_health_reports_a_missing_measurement_entity_and_retention_prunes(tmp_path: Path, world: World) -> None:
    clock = FakeClock(NOW)
    with make_client(tmp_path, world, clock) as client:
        configure(client, grid={"entity": "sensor.nope_grid"})
        prime(client, world)
        run_job(client, "health.evaluate")
        problems = client.get("/api/problems").json()["active"]
        keys = {p["key"] for p in problems}
        assert "measurements.entity_missing" in keys
        missing = next(p for p in problems if p["key"] == "measurements.entity_missing")
        assert "sensor.nope_grid" in missing["detail"]
        assert missing["link"] == "#/settings?section=measurements"

        run = run_job(client, "maintenance.retention")
        assert run["outcome"] == "ok"
        assert "measurement" in client.get("/api/storage").json()["last_cleanup"]["removed"]


def test_a_missing_history_integration_is_explained_and_backed_off(tmp_path: Path, world: World) -> None:
    clock = FakeClock(NOW)
    world.ha_history_status = 404
    with make_client(tmp_path, world, clock) as client:
        configure(client)
        prime(client, world)
        run = run_job(client, "measure.backfill")
        assert run["outcome"] == "error"
        assert "history integration isn't loaded" in run["error"] and "next try in 5 min" in run["error"]
        job = next(j for j in client.get("/api/jobs").json() if j["id"] == "measure.backfill")
        assert job["next_run"] == "2026-10-09T11:05:20.000+00:00"  # not five seconds later
        run = run_job(client, "measure.backfill")
        assert "next try in 10 min" in run["error"]
        sample = run_job(client, "measure.sample")
        assert sample["outcome"] == "error" and "history integration" in sample["error"]
        run_job(client, "health.evaluate")
        problems = {p["key"]: p for p in client.get("/api/problems").json()["active"]}
        assert "measurements.unavailable" in problems
        assert "history integration" in problems["measurements.unavailable"]["detail"]
        assert "measurements.stale" not in problems
