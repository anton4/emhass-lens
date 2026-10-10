"""Phase 2/3: live MPC, publishing, take over / hand back, ML, MQTT entities."""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from emhass_lens.app import create_app
from emhass_lens.bootstrap import Bootstrap
from emhass_lens.core.clock import FakeClock
from emhass_lens.services.outputs import discovery, topics
from emhass_lens.settings.model import Settings
from tests.test_phase1 import prime, run_job, ticks
from tests.world import EMHASS_URL, HA_URL, TZ, World

START = datetime(2026, 10, 9, 11, 13, 0, tzinfo=UTC)
LEGACY_SWITCH = "switch.nordpool_ee_prices_emhass_auto_mpc"


@pytest.fixture
def world() -> World:
    w = World()
    w.standard_entities(datetime(2026, 10, 9, tzinfo=TZ))
    w.set_state(LEGACY_SWITCH, "off")
    return w


def live_client(tmp_path: Path, world: World, clock: FakeClock, **changes) -> TestClient:
    boot = Bootstrap(version="test", data_dir=tmp_path, static_dir=None, ha_url=HA_URL)
    world.clock_now = clock.now
    client = TestClient(create_app(boot, clock=clock, http_transport=world.transport()))
    client.__enter__()
    rev = client.get("/api/settings").json()["revision"]
    body = {"emhass": {"base_url": EMHASS_URL, "mode": "live", "mpc": {"auto": True}}}
    for key, value in changes.items():
        body[key] = value
    saved = client.patch("/api/settings", json={"base_revision": rev, "changes": body})
    assert saved.status_code == 200, saved.text
    run_job(client, "nordpool.poll")
    prime(client, world)
    run_job(client, "emhass.health")
    run_job(client, "emhass.config_check")
    return client


def test_live_mpc_sends_payload_and_verifies_the_plan(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        run = run_job(client, "emhass.mpc")
        assert run["outcome"] == "ok", run
        assert run["summary"].startswith("Planned ")
        [(_, payload)] = [a for a in world.emhass_actions if a[0] == "naive-mpc-optim"]
        assert payload["soc_init"] == 0.62
        kinds = {a["kind"] for a in run["artifacts"]}
        assert {"inputs", "request", "explain", "validation", "response", "emhass_last_run"} <= kinds
        plan = client.get("/api/plan").json()
        assert plan["current"]["driver"] == "app"
        assert plan["current"]["run_id"] == run["id"]
        assert plan["driver"] == "app"

        # the next slot starts: publish-data, then the event with the current row. The scheduler is live in
        # this test, so pause the scheduled publish to keep exactly one (manual) publish.
        assert client.post("/api/jobs/emhass.publish/pause").status_code == 200
        clock.set(datetime(2026, 10, 9, 11, 15, 2, tzinfo=UTC))
        pub = run_job(client, "emhass.publish")
        assert pub["outcome"] == "ok", pub
        assert [a[0] for a in world.emhass_actions][-1] == "publish-data"
        [(event_type, event)] = world.ha_events
        assert event_type == "emhass_lens_plan_published"
        assert event["slot_start"] == "2026-10-09T11:15:00.000+00:00"
        assert set(event["current"]) >= {"p_batt_w", "p_grid_w", "soc_opt"}
        assert "import" in event["price"]
    finally:
        client.__exit__(None, None, None)


def test_double_driver_is_refused(tmp_path: Path, world: World) -> None:
    world.set_state(LEGACY_SWITCH, "on")
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        assert client.get("/api/status").json()["driver"] == "both"
        run = run_job(client, "emhass.mpc")
        assert run["outcome"] == "refused"
        assert "Auto MPC is still on" in run["summary"]
        assert not [a for a in world.emhass_actions if a[0] == "naive-mpc-optim"]
    finally:
        client.__exit__(None, None, None)


def test_take_over_and_hand_back(tmp_path: Path, world: World) -> None:
    world.set_state(LEGACY_SWITCH, "on")
    clock = FakeClock(START)
    boot = Bootstrap(version="test", data_dir=tmp_path, static_dir=None, ha_url=HA_URL)
    world.clock_now = clock.now
    with TestClient(create_app(boot, clock=clock, http_transport=world.transport())) as client:
        prime(client, world)
        rev = client.get("/api/settings").json()["revision"]
        result = client.post("/api/driver/take-over", json={"base_revision": rev}).json()
        assert result["ok"] is True, result
        assert result["legacy_switch"] == "off"
        assert ("switch/turn_off", {"entity_id": LEGACY_SWITCH}) in world.ha_services
        settings = client.get("/api/settings").json()["settings"]
        assert settings["emhass"]["mode"] == "live"
        assert settings["emhass"]["mpc"]["auto"] is True
        assert client.get("/api/status").json()["driver"] == "app"

        back = client.post("/api/driver/hand-back", json={}).json()
        assert back["ok"] is True, back
        assert world.ha_states[LEGACY_SWITCH]["state"] == "on"
        assert client.get("/api/settings").json()["settings"]["emhass"]["mode"] == "dry_run"
        runs = {r["job"]: r for r in client.get("/api/runs").json()}
        assert runs["driver.take_over"]["outcome"] == "ok"
        assert runs["driver.hand_back"]["outcome"] == "ok"


@pytest.mark.parametrize(("status", "outcome"), [("infeasible", "infeasible"), ("error", "error")])
def test_emhass_failures_are_recorded(tmp_path: Path, world: World, status: str, outcome: str) -> None:
    world.action_status = status
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        run = run_job(client, "emhass.mpc")
        assert run["outcome"] == outcome, run
        if outcome == "error":
            response = client.get(f"/api/runs/{run['id']}/artifacts/response").json()
            assert response["error_lines"] == ["ERROR - solver failed"]
    finally:
        client.__exit__(None, None, None)


def test_ml_fit_records_lags_and_flags_a_change(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        started = client.post("/api/ml/fit", json={"historic_days": 20}).json()
        run_id = started["run_id"]
        run: dict = {}
        for _ in ticks():
            run = client.get(f"/api/runs/{run_id}").json()
            if run["outcome"] != "running":
                break
        assert run["outcome"] == "ok", run
        [(_, payload)] = [a for a in world.emhass_actions if a[0] == "forecast-model-fit"]
        assert payload["num_lags"] == 192
        assert payload["split_date_delta"] == "48h"
        assert payload["historic_days_to_retrieve"] == 20
        container = client.app.state.container  # type: ignore[attr-defined]
        assert container.extras["ml"].lags_mismatch() is None
        rev = client.get("/api/settings").json()["revision"]
        client.patch("/api/settings", json={"base_revision": rev, "changes": {"forecast": {"source": "fi_ha_entity"}}})
        assert "fitted with 192 lags; runs now use 288" in container.extras["ml"].lags_mismatch()
    finally:
        client.__exit__(None, None, None)


def test_mqtt_discovery_messages() -> None:
    messages = {m.topic: json.loads(m.payload) for m in discovery(Settings(), "1.2.3")}
    sensor = messages["homeassistant/sensor/emhass_lens/import_price/config"]
    assert sensor["unique_id"] == "emhass_lens_import_price"
    assert sensor["default_entity_id"] == "sensor.emhass_lens_import_price"
    assert sensor["state_topic"] == "emhass_lens/state"
    assert sensor["availability_topic"] == "emhass_lens/status"
    assert sensor["device"]["sw_version"] == "1.2.3"
    switch = messages["homeassistant/switch/emhass_lens/auto_mpc/config"]
    assert switch["command_topic"] == topics(Settings())["auto_mpc_set"]
    assert "homeassistant/button/emhass_lens/run_mpc/config" in messages
    assert "homeassistant/binary_sensor/emhass_lens/hold/config" in messages
    assert len(messages) == 7


class FakeLink:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str, bool]] = []

    async def publish(self, topic: str, payload: str, retain: bool) -> None:
        self.sent.append((topic, payload, retain))


def test_mqtt_state_and_commands(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        container = client.app.state.container  # type: ignore[attr-defined]
        outputs = container.extras["outputs"]
        link = FakeLink()
        outputs.link = link
        portal = client.portal
        assert portal is not None
        portal.call(outputs.announce)
        by_topic = {t: p for t, p, _ in link.sent}
        state = json.loads(by_topic["emhass_lens/state"])
        assert state["auto_mpc"] == "ON"
        assert isinstance(state["import_price"], float)
        assert by_topic["emhass_lens/status"] == "online"

        portal.call(outputs.handle, "emhass_lens/auto_mpc/set", "OFF")
        assert client.get("/api/settings").json()["settings"]["emhass"]["mpc"]["auto"] is False
        newest = client.get("/api/settings/revisions").json()[0]
        assert newest["actor"] == "Home Assistant (MQTT)"
        assert json.loads([p for t, p, _ in link.sent if t == "emhass_lens/state"][-1])["auto_mpc"] == "OFF"

        before = len(client.get("/api/runs", params={"job": "emhass.mpc"}).json())
        portal.call(outputs.handle, "emhass_lens/run_mpc/press", "PRESS")
        runs: list[dict] = []
        for _ in ticks():
            runs = client.get("/api/runs", params={"job": "emhass.mpc"}).json()
            if len(runs) > before and runs[0]["outcome"] != "running":
                break
        assert len(runs) == before + 1
        assert runs[0]["trigger"] == "manual"
    finally:
        client.__exit__(None, None, None)


def test_publish_is_quiet_when_not_live(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START + timedelta(minutes=2))
    boot = Bootstrap(version="test", data_dir=tmp_path, static_dir=None, ha_url=HA_URL)
    with TestClient(create_app(boot, clock=clock, http_transport=world.transport())) as client:
        container = client.app.state.container  # type: ignore[attr-defined]
        assert container.extras["publish"].active() is False
        assert container.scheduler.jobs["emhass.publish"].record() is False
