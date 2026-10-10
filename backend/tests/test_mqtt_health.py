"""MQTT: no problem while the first connection is still being made, and a reason people can act on."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import aiomqtt
import pytest

from emhass_lens.core.clock import FakeClock
from emhass_lens.services.health_rules import evaluate
from emhass_lens.services.outputs import explain_mqtt_error
from emhass_lens.services.problems import Problem
from tests.test_phase1 import make_client, ticks
from tests.world import World

START = datetime(2026, 10, 10, 15, 6, 0, tzinfo=UTC)


@pytest.fixture
def world() -> World:
    return World()


def test_the_reasons_say_what_to_do() -> None:
    broker = "core-mosquitto:1883"
    assert explain_mqtt_error(aiomqtt.MqttCodeError(5, "x"), broker) == (
        "the broker core-mosquitto:1883 refused EMHASS Lens's login ([code:5] The connection was refused.)"
    )
    assert explain_mqtt_error(aiomqtt.MqttCodeError(135, "x"), broker).startswith(
        "the broker core-mosquitto:1883 refused"
    )
    assert explain_mqtt_error(OSError("[Errno 111] Connection refused"), broker) == (
        "can't reach the broker core-mosquitto:1883 ([Errno 111] Connection refused)"
    )
    assert explain_mqtt_error("timed out", None) == "can't reach the broker the broker (timed out)"
    assert explain_mqtt_error("No mqtt service", None, from_supervisor=True).startswith(
        "no MQTT broker App found: install and start the Mosquitto broker App"
    )
    assert explain_mqtt_error(ValueError("something odd"), broker) == "something odd"


def test_no_problem_while_the_first_connection_is_made(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    with make_client(tmp_path, world, clock) as client:
        c = client.app.state.container  # type: ignore[attr-defined]
        c.settings.current.outputs.mqtt_enabled = True
        outputs = c.extras["outputs"]
        outputs.connected, outputs.last_error, outputs.down_since = False, None, START
        outputs.broker = "core-mosquitto:1883"

        def keys(at: datetime) -> dict[str, Problem]:
            return {p.key: p for p in evaluate(c, at)}

        assert "mqtt.disconnected" not in keys(START + timedelta(seconds=30))
        late = keys(START + timedelta(minutes=2, seconds=10))["mqtt.disconnected"]
        assert late.detail == "still connecting to core-mosquitto:1883"
        outputs.last_error = "the broker core-mosquitto:1883 refused EMHASS Lens's login (…)"
        assert keys(START + timedelta(minutes=3))["mqtt.disconnected"].detail == outputs.last_error
        outputs.connected, outputs.down_since = True, None
        assert "mqtt.disconnected" not in keys(START + timedelta(minutes=4))


def test_a_reason_that_arrives_later_is_logged(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    with make_client(tmp_path, world, clock) as client:
        c = client.app.state.container  # type: ignore[attr-defined]
        health = c.scheduler.jobs["health.evaluate"]
        health.paused = True  # the App's own check would clear this test's problem between the syncs
        for _ in ticks():
            if not health.lock.locked():
                break
        problems = c.extras["problems"]
        title = "MQTT entities aren't being updated"
        first = Problem("mqtt.disconnected", "warning", title)
        later = Problem("mqtt.disconnected", "warning", title, "the broker refused")
        client.portal.call(problems.sync, [first])  # type: ignore[union-attr]
        client.portal.call(problems.sync, [later])  # type: ignore[union-attr]
        client.portal.call(problems.sync, [later])  # type: ignore[union-attr]
        lines = [e["msg"] for e in c.logging.ring.tail() if str(e["msg"]).startswith("Problem: MQTT")]
        assert lines == [f"Problem: {title}", f"Problem: {title} (the broker refused)"]
