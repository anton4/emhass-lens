"""After a restart the stored price forecast is restored and only polled when it is due."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from emhass_lens.core.clock import FakeClock
from tests.test_forecast_pv import ee_body
from tests.test_phase1 import make_client, run_job
from tests.world import World

START = datetime(2026, 10, 9, 11, 13, 0, tzinfo=UTC)
EE = "ee_eupowerprices"


@pytest.fixture
def world() -> World:
    w = World()
    w.ee_forecast = ee_body(datetime(2026, 10, 9, 11, 0, tzinfo=UTC), 48)
    return w


def select_ee(client: TestClient) -> None:
    rev = client.get("/api/settings").json()["revision"]
    changes = {"forecast": {"source": EE, "ee": {"api_key": "test-key"}}}
    assert client.patch("/api/settings", json={"base_revision": rev, "changes": changes}).status_code == 200


def forecast_status(client: TestClient) -> dict:
    return client.get("/api/inputs").json()["forecast"]["providers"][EE]


def next_poll(client: TestClient) -> str | None:
    return next(j for j in client.get("/api/jobs").json() if j["id"] == "forecast.ee.poll")["next_run"]


def test_a_restart_restores_the_forecast_and_keeps_the_poll_schedule(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    with make_client(tmp_path, world, clock) as client:
        select_ee(client)
        run = run_job(client, "forecast.ee.poll")
        assert run["outcome"] == "ok", run
        assert world.ee_calls == 1
        assert forecast_status(client)["points"] == 48

    # 20 minutes later the App starts again on the same data
    clock.set(START + timedelta(minutes=20))
    with make_client(tmp_path, world, clock) as client:
        st = forecast_status(client)
        assert st["points"] == 48 and st["last_success"] == "2026-10-09T11:13:00.000+00:00"
        assert st["start"] == "2026-10-09T11:00:00.000+00:00" and st["end"] is not None
        assert next_poll(client) == "2026-10-09T12:13:00.000+00:00"  # last success + 1 h, not start + 5 s
        run_job(client, "health.evaluate")
        keys = {p["key"] for p in client.get("/api/problems").json()["active"]}
        assert "forecast.missing" not in keys
        assert world.ee_calls == 1  # nothing was fetched again
        # the forecast is used: priced slots beyond Nord Pool's days come from it
        run_job(client, "nordpool.poll")
        slots = client.get("/api/prices", params={"days_back": 0}).json()["slots"]
        assert any(s["origin"].startswith("forecast:") for s in slots)

        # once the interval has passed, polling resumes as usual
        clock.set(START + timedelta(hours=2))
        run = run_job(client, "forecast.ee.poll")
        assert run["outcome"] == "ok" and run["summary"].endswith("(unchanged)")
        assert world.ee_calls == 2


def test_a_forecast_that_has_run_out_is_not_restored_but_its_status_is(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    with make_client(tmp_path, world, clock) as client:
        select_ee(client)
        assert run_job(client, "forecast.ee.poll")["outcome"] == "ok"

    clock.set(START + timedelta(days=3))  # the 48 h series is over
    with make_client(tmp_path, world, clock) as client:
        st = forecast_status(client)
        assert st["last_success"] == "2026-10-09T11:13:00.000+00:00" and st["points"] == 48
        assert st["start"] is None and st["end"] is None  # not offered as the current forecast
        assert next_poll(client) == "2026-10-12T11:13:01.000+00:00"  # overdue: polls right after start
        assert world.ee_calls == 1


def test_a_failed_poll_is_remembered_across_a_restart(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    world.ee_status = 500
    with make_client(tmp_path, world, clock) as client:
        select_ee(client)
        assert run_job(client, "forecast.ee.poll")["outcome"] == "error"
    clock.set(START + timedelta(minutes=1))
    with make_client(tmp_path, world, clock) as client:
        st = forecast_status(client)
        assert st["consecutive_errors"] == 1 and st["last_success"] is None and st["error"]
        assert next_poll(client) == "2026-10-09T11:18:00.000+00:00"  # the 5-minute backoff from the attempt
