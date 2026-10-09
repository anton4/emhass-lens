"""Regression tests for issues found in the code review (2026-10-09)."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from emhass_lens.core.clock import FakeClock
from tests.test_inverter_service import set_mode
from tests.test_inverter_service import world as inverter_world  # noqa: F401 - fixture
from tests.test_phase1 import make_client, prime, run_job
from tests.test_phase2 import LEGACY_SWITCH, live_client
from tests.world import TZ, World

START = datetime(2026, 10, 9, 11, 13, 0, tzinfo=UTC)


@pytest.fixture
def world() -> World:
    w = World()
    w.standard_entities(datetime(2026, 10, 9, tzinfo=TZ))
    w.set_state(LEGACY_SWITCH, "off")
    return w


def container(client: TestClient):
    return client.app.state.container  # type: ignore[attr-defined]


def test_a_delivered_day_without_prices_backs_off(tmp_path: Path, world: World) -> None:
    del world.nordpool_days["2026-10-09"]  # today's delivery day answers 204
    clock = FakeClock(START)
    with make_client(tmp_path, world, clock) as client:
        run_job(client, "nordpool.poll")
        svc = container(client).extras["prices"]
        assert svc.next_poll(clock.now()) >= clock.now() + timedelta(seconds=60)
        clock.advance(seconds=61)
        run_job(client, "nordpool.poll")
        state = svc.states[datetime(2026, 10, 9).date()]
        assert state.consecutive_errors >= 1
        assert svc.next_poll(clock.now()) >= clock.now() + timedelta(minutes=1)
        assert world.nordpool_calls.count("2026-10-09") <= 3


def test_a_malformed_response_is_a_failed_fetch_not_a_crash(tmp_path: Path, world: World) -> None:
    broken = dict(world.nordpool_days["2026-10-09"])
    broken["multiAreaEntries"] = [{"deliveryStart": "2026-10-08T22:00:00Z", "entryPerArea": {"EE": 1.0}}]  # no end
    world.nordpool_days["2026-10-09"] = broken
    clock = FakeClock(START)
    with make_client(tmp_path, world, clock) as client:
        run = run_job(client, "nordpool.poll")
        assert run["outcome"] == "error"
        assert "KeyError" in run["error"]
        svc = container(client).extras["prices"]
        assert svc.states[datetime(2026, 10, 9).date()].consecutive_errors == 1
        assert svc.next_poll(clock.now()) >= clock.now() + timedelta(seconds=60)


def test_mpc_claims_a_plan_the_watcher_stored_first(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        c = container(client)
        emhass = c.extras["emhass"]
        original = emhass.watch_plan

        async def watcher_first(ctx, *, driver="external", run_id=None):  # the 5-minute watcher wins the race
            await original(ctx, driver="external", run_id=None)
            return False

        emhass.watch_plan = watcher_first
        run = run_job(client, "emhass.mpc")
        assert run["outcome"] == "ok", run
        plan = client.get("/api/plan").json()
        assert plan["current"]["driver"] == "app"
        assert plan["current"]["run_id"] == run["id"]
    finally:
        client.__exit__(None, None, None)


def test_inverter_ignores_sensors_from_an_earlier_slot(tmp_path: Path, inverter_world: World) -> None:  # noqa: F811
    for sensor in ("sensor.p_batt_forecast", "sensor.p_grid_forecast"):
        inverter_world.set_state(
            sensor, inverter_world.ha_states[sensor]["state"], updated=datetime(2026, 10, 9, 10, 50, tzinfo=UTC)
        )  # previous slot
    clock = FakeClock(START)
    client = live_client(tmp_path, inverter_world, clock)
    try:
        set_mode(client, inverter_world, "dry_run")
        run = run_job(client, "inverter.decide")
        assert run["outcome"] == "noop"
        assert "weren't updated for this slot" in run["summary"]
    finally:
        client.__exit__(None, None, None)


def test_inverter_live_refuses_without_a_home_assistant_connection(tmp_path: Path, inverter_world: World) -> None:  # noqa: F811
    clock = FakeClock(START)
    client = live_client(tmp_path, inverter_world, clock)
    try:
        assert run_job(client, "emhass.mpc")["outcome"] == "ok"
        set_mode(client, inverter_world, "live")
        container(client).extras["ha"].connected = False
        run = run_job(client, "inverter.decide")
        assert run["outcome"] == "refused"
        assert "Not connected" in run["summary"]
        assert not [s for s in inverter_world.ha_services if s[0].startswith("number")]
    finally:
        client.__exit__(None, None, None)


def test_inverter_live_rereads_the_mfrr_interlock_before_writing(tmp_path: Path, inverter_world: World) -> None:  # noqa: F811
    clock = FakeClock(START)
    client = live_client(tmp_path, inverter_world, clock)
    try:
        assert run_job(client, "emhass.mpc")["outcome"] == "ok"
        set_mode(client, inverter_world, "live")
        inverter_world.set_state("input_boolean.emhass_automation", "off")  # mFRR session; the cache still says on
        run = run_job(client, "inverter.decide")
        assert run["outcome"] == "refused"
        assert "mFRR" in run["summary"]
        assert not [s for s in inverter_world.ha_services if s[0].startswith("number")]
    finally:
        client.__exit__(None, None, None)


def test_take_over_with_a_stale_page_leaves_the_switch_alone(tmp_path: Path, world: World) -> None:
    world.set_state(LEGACY_SWITCH, "on")
    clock = FakeClock(START)
    with make_client(tmp_path, world, clock, safe_mode=False) as client:
        prime(client, world)
        resp = client.post("/api/driver/take-over", json={"base_revision": 999})
        assert resp.status_code == 409
        assert world.ha_states[LEGACY_SWITCH]["state"] == "on"
        assert not world.ha_services


class FakeLink:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str, bool]] = []

    async def publish(self, topic: str, payload: str, retain: bool) -> None:
        self.sent.append((topic, payload, retain))


def test_mqtt_says_offline_and_clears_entities_when_turned_off(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    with make_client(tmp_path, world, clock) as client:
        outputs = container(client).extras["outputs"]
        link = FakeLink()
        outputs.link = link
        assert client.portal is not None
        client.portal.call(lambda: outputs.stop(clear=True))
        sent = {topic: payload for topic, payload, _ in link.sent}
        assert sent["emhass_lens/status"] == "offline"
        assert sent["homeassistant/sensor/emhass_lens/import_price/config"] == ""


def test_ml_counter_keeps_mpc_blocked_until_every_ml_action_is_done(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    with make_client(tmp_path, world, clock) as client:
        c = container(client)
        c.extras["ml_running"] = 2  # two ML actions in flight; one finishes
        c.extras["ml_running"] = max(0, c.extras["ml_running"] - 1)
        codes = {i.code for i in c.extras["mpc"]._preflight(send=True)}
        assert "ml_fit_running" in codes
