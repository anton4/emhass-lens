"""Phase 1 end to end: prices, forecasts, PV, shadow MPC builds, EMHASS checks, plans and parity."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from emhass_lens.app import create_app
from emhass_lens.bootstrap import Bootstrap
from emhass_lens.core.clock import FakeClock
from tests.legacy import legacy_math
from tests.world import EMHASS_URL, HA_URL, TZ, World

START = datetime(2026, 10, 9, 11, 13, 0, tzinfo=UTC)  # 14:13 local, a scheduled MPC time


@pytest.fixture
def world() -> World:
    w = World()
    w.standard_entities(datetime(2026, 10, 9, tzinfo=TZ))
    return w


def make_client(tmp_path: Path, world: World, clock: FakeClock, **boot_kwargs) -> TestClient:
    boot = Bootstrap(version="test", data_dir=tmp_path, static_dir=None, safe_mode=True, ha_url=HA_URL, **boot_kwargs)
    world.clock_now = clock.now
    return TestClient(create_app(boot, clock=clock, http_transport=world.transport()))


def run_job(client: TestClient, job: str) -> dict:
    started = client.post(f"/api/jobs/{job}/run").json()
    run_id = started["run_id"]
    if run_id is None:  # jobs that don't record runs: wait until the job is idle again
        for _ in range(200):
            info = next(j for j in client.get("/api/jobs").json() if j["id"] == job)
            if not info["running"]:
                return info
        raise AssertionError(f"{job} didn't finish")
    for _ in range(200):
        run = client.get(f"/api/runs/{run_id}").json()
        if run["outcome"] != "running":
            return run
    raise AssertionError(f"{job} didn't finish")


def prime(client: TestClient, world: World) -> None:
    """Give the app what the WebSocket would: the watched entity states."""
    app = client.app
    ha = app.state.container.extras["ha"]  # type: ignore[attr-defined]
    for entity_id in ha.watched:
        if entity_id in world.ha_states:
            ha.states[entity_id] = world.ha_states[entity_id]
    ha.connected = True
    ha.time_zone = "Europe/Tallinn"


def configure_emhass(client: TestClient) -> None:
    rev = client.get("/api/settings").json()["revision"]
    ok = client.patch("/api/settings", json={"base_revision": rev, "changes": {"emhass": {"base_url": EMHASS_URL}}})
    assert ok.status_code == 200, ok.text


def test_prices_fetch_per_delivery_day_and_price_breakdown(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    with make_client(tmp_path, world, clock) as client:
        run = run_job(client, "nordpool.poll")
        assert run["outcome"] == "ok", run
        assert sorted(world.nordpool_calls) == ["2026-10-08", "2026-10-09", "2026-10-10"]
        prices = client.get("/api/prices", params={"days_back": 0}).json()
        assert prices["timezone"] == "Europe/Tallinn"
        first = prices["slots"][0]
        assert first["start"] == "2026-10-08T21:00:00.000+00:00"  # local midnight
        assert first["period"] == "night"
        assert prices["actual_end"] == "2026-10-10T22:00:00.000+00:00"
        assert {d["state"] for d in prices["nordpool"]["days"] if d["slots"]} == {"Final"}
        assert prices["nordpool"]["next"] == []  # everything needed is Final


def test_tomorrow_not_published_is_not_an_error(tmp_path: Path, world: World) -> None:
    del world.nordpool_days["2026-10-10"]
    clock = FakeClock(datetime(2026, 10, 9, 10, 50, tzinfo=UTC))  # 13:50 local, fast window
    with make_client(tmp_path, world, clock) as client:
        run = run_job(client, "nordpool.poll")
        assert run["outcome"] == "ok"
        assert "not published yet (HTTP 204)" in run["summary"]
        nxt = client.get("/api/prices").json()["nordpool"]["next"]
        assert nxt[0]["day"] == "2026-10-10"
        assert "fast window" in nxt[0]["reason"]


def test_shadow_mpc_build_matches_legacy_and_explains_itself(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    with make_client(tmp_path, world, clock) as client:
        run_job(client, "nordpool.poll")
        prime(client, world)
        run = run_job(client, "emhass.mpc")
        assert run["outcome"] == "shadow", run
        assert run["summary"].startswith("Built ")
        kinds = {a["kind"] for a in run["artifacts"]}
        assert {"inputs", "request", "explain", "validation"} <= kinds
        payload = client.get(f"/api/runs/{run['id']}/artifacts/request").json()
        explain = client.get(f"/api/runs/{run['id']}/artifacts/explain").json()
        assert explain["anchor"] == "2026-10-09T11:15:00.000+00:00"
        assert payload["prediction_horizon"] == len(explain["slots"]) == payload["prediction_horizon"]
        assert payload["soc_init"] == 0.62
        inputs = client.get(f"/api/runs/{run['id']}/artifacts/inputs").json()
        assert inputs["soc_init"]["source"] == "sensor.ev6_battery_soc"
        assert "× 0.01" in inputs["soc_init"]["explain"]

        # The compat build (kept for parity) equals what the HACS integration would have sent
        shadow = client.app.state.container.extras["mpc"].last_shadow  # type: ignore[attr-defined]
        legacy_raw = []
        for day in ("2026-10-08", "2026-10-09", "2026-10-10"):
            legacy_raw += legacy_math.price_dict_from_response(world.nordpool_days[day]).values()
        legacy_raw.sort(key=lambda p: p["start"])
        now_local = START.astimezone(TZ)
        from_now = legacy_math.prices_from_now(legacy_raw, legacy_math.LEGACY_DEFAULT_OPTS, now_local)
        assert (
            shadow.compat.payload["load_cost_forecast"]
            == legacy_math.mpc_payload(from_now, [0] * from_now["timestamps_left"], 0.62, 0.8, now_local, 0)[
                "load_cost_forecast"
            ]
        )


def test_unavailable_soc_is_reported_not_hidden(tmp_path: Path, world: World) -> None:
    world.set_state("sensor.ev6_battery_soc", "unavailable")
    clock = FakeClock(START)
    with make_client(tmp_path, world, clock) as client:
        run_job(client, "nordpool.poll")
        prime(client, world)
        run = run_job(client, "emhass.mpc")
        assert run["outcome"] == "shadow"
        assert "Would refuse" in run["summary"]
        assert "entity is 'unavailable'" in run["summary"]
        validation = client.get(f"/api/runs/{run['id']}/artifacts/validation").json()
        assert any(v["code"] == "soc_unavailable" and v["level"] == "error" for v in validation)


def test_emhass_checks_and_plan_watch(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    with make_client(tmp_path, world, clock) as client:
        configure_emhass(client)
        prime(client, world)
        run_job(client, "emhass.health")  # record=False: returns no run id
        check = run_job(client, "emhass.config_check")
        assert check["outcome"] == "ok", check
        status = client.get("/api/emhass").json()
        assert status["reachable"] is True
        assert status["version"] == "0.18.3"
        assert status["method_ts_round"] == "nearest"
        by_key = {c["key"]: c["status"] for c in status["checks"]}
        assert by_key["optimization_time_step"] == "ok"
        assert by_key["method_ts_round"] == "ok"
        assert by_key["version"] == "ok"

        # a plan made by someone else (the HACS integration) is picked up and served with prices
        run_job(client, "nordpool.poll")
        payload = {
            "load_cost_forecast": [0.1, 0.2],
            "prod_price_forecast": [0.05, 0.06],
            "pv_power_forecast": [0, 100],
            "soc_init": 0.5,
        }
        from tests.world import make_plan

        world.emhass_plan = make_plan(START, payload)
        world.emhass_last_run = {"status": "ok", "timestamp": START.isoformat()}
        watch = run_job(client, "emhass.plan_watch")
        assert "Plan of" in watch["summary"]
        plan = client.get("/api/plan").json()
        assert plan["available"] is True
        assert len(plan["current"]["rows"]) == 2
        assert plan["prices"][0]["start"] == "2026-10-09T11:15:00.000+00:00"
        again = run_job(client, "emhass.plan_watch")
        assert again["outcome"] == "noop"


def test_emhass_unreachable_shows_in_status(tmp_path: Path, world: World) -> None:
    world.emhass_up = False
    clock = FakeClock(START)
    with make_client(tmp_path, world, clock) as client:
        configure_emhass(client)
        run_job(client, "emhass.health")
        status = client.get("/api/emhass").json()
        assert status["reachable"] is False
        assert "connect" in status["last_error"]


def test_ee_forecast_extends_prices_and_backs_off_on_errors(tmp_path: Path, world: World) -> None:
    start = datetime(2026, 10, 10, 12, 0, tzinfo=UTC)
    world.ee_forecast = {
        "series": [
            {"ts_utc": (start + timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M:%SZ"), "price_eur_mwh": 60.0 + h}
            for h in range(72)
        ]
    }
    clock = FakeClock(START)
    with make_client(tmp_path, world, clock) as client:
        rev = client.get("/api/settings").json()["revision"]
        client.patch(
            "/api/settings",
            json={
                "base_revision": rev,
                "changes": {
                    "forecast": {"source": "ee_eupowerprices", "extend_days": 1, "ee": {"api_key": "secret-key-123"}}
                },
            },
        )
        run_job(client, "nordpool.poll")
        run = run_job(client, "forecast.ee.poll")
        assert run["outcome"] == "ok", run
        prices = client.get("/api/prices", params={"days_back": 0}).json()
        forecast_slots = [s for s in prices["slots"] if s["origin"] == "forecast:ee_eupowerprices"]
        assert len(forecast_slots) == 96
        assert prices["forecast_until"] == "2026-10-11T22:00:00.000+00:00"
        logs = client.get("/api/logs", params={"q": "secret-key-123"}).json()
        assert logs == []

        world.ee_status = 401
        failed = run_job(client, "forecast.ee.poll")
        assert failed["outcome"] == "error"
        assert "check the API key" in failed["error"]
        job = next(j for j in client.get("/api/jobs").json() if j["id"] == "forecast.ee.poll")
        due = datetime.fromisoformat(job["next_run"])
        assert timedelta(minutes=4) < due - clock.now() <= timedelta(minutes=5)  # backoff, not every minute


def test_parity_with_legacy_entities(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    legacy_raw = []
    for day in ("2026-10-08", "2026-10-09", "2026-10-10"):
        legacy_raw += legacy_math.price_dict_from_response(world.nordpool_days[day]).values()
    legacy_raw.sort(key=lambda p: p["start"])
    opts = legacy_math.LEGACY_DEFAULT_OPTS
    imports = legacy_math.calculated_prices(legacy_raw, "import", opts)
    exports = legacy_math.calculated_prices(legacy_raw, "export", opts)
    now_local = START.astimezone(TZ)
    world.set_state("sensor.nordpool_ee_prices_import_cost", "x", {"prices": imports}, START)
    world.set_state("sensor.nordpool_ee_prices_export_cost", "x", {"prices": exports}, START)
    world.set_state(
        "sensor.nordpool_ee_prices_prices_from_now",
        "x",
        legacy_math.prices_from_now(legacy_raw, opts, now_local),
        START,
    )
    with make_client(tmp_path, world, clock) as client:
        run_job(client, "nordpool.poll")
        prime(client, world)
        run = run_job(client, "parity.check")
        assert run["outcome"] == "ok", run
        report = client.get(f"/api/runs/{run['id']}/artifacts/parity").json()
        names = {s["name"]: s for s in report["sections"]}
        assert names["import_cost (timestamped)"]["equal"] == len(imports)
        assert names["prices_from_now import"]["ok"] is True

        # a tariff change in the App only shows up as a difference
        rev = client.get("/api/settings").json()["revision"]
        client.patch("/api/settings", json={"base_revision": rev, "changes": {"prices": {"tariff": {"vat_pct": 22}}}})
        drift = run_job(client, "parity.check")
        assert drift["outcome"] == "mismatch"


def test_health_problems_and_entity_picker(tmp_path: Path, world: World) -> None:
    clock = FakeClock(datetime(2026, 10, 9, 15, 0, tzinfo=UTC))  # 18:00 local
    del world.nordpool_days["2026-10-10"]
    with make_client(tmp_path, world, clock) as client:
        run_job(client, "nordpool.poll")
        prime(client, world)
        c = client.app.state.container  # type: ignore[attr-defined]
        import asyncio

        from emhass_lens.services import health_rules

        keys = {p.key for p in health_rules.evaluate(c, clock.now())}
        assert "prices.tomorrow_missing" in keys
        entities = client.get("/api/ha/entities", params={"domain": "sensor", "q": "soc"}).json()
        assert [e["entity_id"] for e in entities] == ["sensor.ev6_battery_soc"]
        assert entities[0]["unit"] == "%"
        _ = asyncio
