"""Home Assistant entities over MQTT discovery: one "EMHASS Lens" device with a few small entities.

- Import price now / Export price now (€/kWh, numeric, for automations and the Energy dashboard)
- Problem (binary sensor), Last successful MPC (timestamp)
- Auto MPC (switch), Run MPC now (button)

Discovery and state messages are retained, so the entities survive Home Assistant restarts; the
App re-sends everything when HA announces itself on homeassistant/status.
"""

import asyncio
import contextlib
import json
import logging
import ssl
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

from emhass_lens.core.clock import iso
from emhass_lens.core.slots import slot_floor
from emhass_lens.settings.model import Settings

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.mqtt")

DEVICE_ID = "emhass_lens"


@dataclass(frozen=True)
class Message:
    topic: str
    payload: str
    retain: bool = True


def topics(settings: Settings) -> dict[str, str]:
    base = settings.outputs.topic_prefix.rstrip("/")
    return {
        "availability": f"{base}/status",
        "state": f"{base}/state",
        "attributes": f"{base}/attributes",
        "auto_mpc_set": f"{base}/auto_mpc/set",
        "run_mpc": f"{base}/run_mpc/press",
    }


def discovery(settings: Settings, version: str) -> list[Message]:
    """The discovery config messages (pure: settings in, messages out)."""
    t = topics(settings)
    prefix = settings.outputs.discovery_prefix.rstrip("/")
    device = {
        "identifiers": [DEVICE_ID],
        "name": "EMHASS Lens",
        "manufacturer": "EMHASS Lens",
        "model": "EMHASS companion App",
        "sw_version": version,
    }
    common = {"availability_topic": t["availability"], "device": device}
    entities: list[tuple[str, str, dict[str, Any]]] = [
        (
            "sensor",
            "import_price",
            {
                "name": "Import price now",
                "state_topic": t["state"],
                "value_template": "{{ value_json.import_price }}",
                "unit_of_measurement": "EUR/kWh",
                "state_class": "measurement",
                "suggested_display_precision": 4,
                "icon": "mdi:transmission-tower-import",
                "json_attributes_topic": t["attributes"],
                "json_attributes_template": "{{ value_json.import | tojson }}",
            },
        ),
        (
            "sensor",
            "export_price",
            {
                "name": "Export price now",
                "state_topic": t["state"],
                "value_template": "{{ value_json.export_price }}",
                "unit_of_measurement": "EUR/kWh",
                "state_class": "measurement",
                "suggested_display_precision": 4,
                "icon": "mdi:transmission-tower-export",
                "json_attributes_topic": t["attributes"],
                "json_attributes_template": "{{ value_json.export | tojson }}",
            },
        ),
        (
            "binary_sensor",
            "problem",
            {
                "name": "Problem",
                "state_topic": t["state"],
                "value_template": "{{ value_json.problem }}",
                "payload_on": "ON",
                "payload_off": "OFF",
                "device_class": "problem",
                "json_attributes_topic": t["attributes"],
                "json_attributes_template": "{{ value_json.problems | tojson }}",
            },
        ),
        (
            "sensor",
            "last_mpc",
            {
                "name": "Last successful MPC",
                "state_topic": t["state"],
                "value_template": "{{ value_json.last_mpc }}",
                "device_class": "timestamp",
                "entity_category": "diagnostic",
            },
        ),
        (
            "switch",
            "auto_mpc",
            {
                "name": "Auto MPC",
                "state_topic": t["state"],
                "value_template": "{{ value_json.auto_mpc }}",
                "command_topic": t["auto_mpc_set"],
                "payload_on": "ON",
                "payload_off": "OFF",
                "icon": "mdi:robot",
            },
        ),
        (
            "button",
            "run_mpc",
            {
                "name": "Run MPC now",
                "command_topic": t["run_mpc"],
                "payload_press": "PRESS",
                "icon": "mdi:play",
            },
        ),
    ]
    out = []
    for component, key, config in entities:
        payload = {**common, **config, "unique_id": f"{DEVICE_ID}_{key}", "object_id": f"{DEVICE_ID}_{key}"}
        out.append(Message(f"{prefix}/{component}/{DEVICE_ID}/{key}/config", json.dumps(payload)))
    return out


def state_messages(c: Container) -> list[Message]:
    settings = c.settings.current
    t = topics(settings)
    now = c.clock.now()
    slot = slot_floor(now)
    prices = c.extras["prices"].priced(slot, c.extras["forecasts"].current())
    current = prices[0] if prices and prices[0].start == slot else None
    following = prices[1] if current and len(prices) > 1 else None
    problems = c.extras["problems"].active()
    last = c.extras["mpc"].last_success_at
    state = {
        "import_price": round(current.import_price, 5) if current else None,
        "export_price": round(current.export_price, 5) if current else None,
        "problem": "ON" if problems else "OFF",
        "last_mpc": iso(last) if last else None,
        "auto_mpc": "ON" if settings.emhass.mpc.auto else "OFF",
    }

    def price_attrs(kind: str) -> dict[str, Any]:
        if current is None:
            return {}
        attrs: dict[str, Any] = {
            "slot_start": iso(current.start),
            "period": current.period,
            "is_forecast": current.is_forecast,
            "spot": round(current.spot, 5),
        }
        if following is not None:
            attrs["next_slot_start"] = iso(following.start)
            attrs["next"] = round(following.import_price if kind == "import" else following.export_price, 5)
        return attrs

    attributes = {
        "import": price_attrs("import"),
        "export": price_attrs("export"),
        "problems": {"active": [p["title"] for p in problems], "keys": [p["key"] for p in problems]},
    }
    return [Message(t["state"], json.dumps(state)), Message(t["attributes"], json.dumps(attributes))]


class MqttLink(Protocol):
    async def publish(self, topic: str, payload: str, retain: bool) -> None: ...


class OutputService:
    def __init__(self, c: Container) -> None:
        self.c = c
        self.connected = False
        self.last_error: str | None = None
        self.broker: str | None = None
        self.link: MqttLink | None = None
        self._task: asyncio.Task[None] | None = None
        self._last_state: list[Message] = []

    # --- lifecycle --------------------------------------------------------------------------------------
    def enabled(self) -> bool:
        return self.c.settings.current.outputs.mqtt_enabled

    def start(self) -> None:
        if self.enabled() and self._task is None:
            self._task = asyncio.create_task(self._run(), name="mqtt")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        self.connected = False
        self.link = None

    async def restart(self) -> None:
        await self.stop()
        self.start()

    # --- publishing ---------------------------------------------------------------------------------------
    async def refresh(self) -> None:
        """Publish the current state (no-op while not connected)."""
        if self.link is None:
            return
        messages = state_messages(self.c)
        for message in messages:
            await self.link.publish(message.topic, message.payload, message.retain)
        self._last_state = messages

    async def announce(self) -> None:
        if self.link is None:
            return
        settings = self.c.settings.current
        await self.link.publish(topics(settings)["availability"], "online", True)
        for message in discovery(settings, self.c.boot.version):
            await self.link.publish(message.topic, message.payload, message.retain)
        await self.refresh()

    async def handle(self, topic: str, payload: str) -> None:
        settings = self.c.settings.current
        t = topics(settings)
        if topic == f"{settings.outputs.discovery_prefix}/status" and payload == "online":
            log.info("Home Assistant came online; re-sending discovery")
            await self.announce()
        elif topic == t["auto_mpc_set"] and payload in ("ON", "OFF"):
            want = payload == "ON"
            if settings.emhass.mpc.auto != want:
                log.info("Auto MPC turned %s from Home Assistant", payload.lower())
                await self.c.settings.save(
                    {"emhass": {"mpc": {"auto": want}}},
                    base_revision=None,
                    actor="Home Assistant (MQTT)",
                    source="ui",
                    comment=f"Auto MPC {payload.lower()} via the MQTT switch",
                )
            await self.refresh()
        elif topic == t["run_mpc"]:
            log.info("Run MPC pressed in Home Assistant")
            self.c.scheduler.run_now("emhass.mpc")

    # --- connection --------------------------------------------------------------------------------------------
    async def _credentials(self) -> dict[str, Any]:
        broker = self.c.settings.current.outputs.broker
        if broker.host:
            return {
                "host": broker.host,
                "port": broker.port,
                "username": broker.username or None,
                "password": broker.password or None,
                "ssl": broker.tls,
            }
        supervisor = self.c.extras["supervisor"]
        if not supervisor.available:
            raise RuntimeError("no MQTT broker: set Settings → Home Assistant outputs → MQTT broker")
        info = await supervisor.mqtt_service()
        return {
            "host": info.get("host"),
            "port": int(info.get("port") or 1883),
            "username": info.get("username"),
            "password": info.get("password"),
            "ssl": bool(info.get("ssl")),
        }

    async def _run(self) -> None:
        import aiomqtt

        backoff = 2.0
        while True:
            settings = self.c.settings.current
            t = topics(settings)
            try:
                creds = await self._credentials()
                self.broker = f"{creds['host']}:{creds['port']}"
                tls = ssl.create_default_context() if creds["ssl"] else None
                async with aiomqtt.Client(
                    creds["host"],
                    creds["port"],
                    username=creds["username"],
                    password=creds["password"],
                    identifier=f"emhass-lens-{self.c.boot.version}",
                    tls_context=tls,
                    will=aiomqtt.Will(t["availability"], "offline", qos=1, retain=True),
                ) as client:
                    self.link = _AioLink(client)
                    self.connected, self.last_error = True, None
                    log.info("Connected to MQTT broker %s", self.broker)
                    await client.subscribe(f"{settings.outputs.discovery_prefix}/status")
                    await client.subscribe(t["auto_mpc_set"])
                    await client.subscribe(t["run_mpc"])
                    await self.announce()
                    backoff = 2.0
                    async for message in client.messages:
                        payload = (
                            message.payload.decode() if isinstance(message.payload, bytes) else str(message.payload)
                        )
                        try:
                            await self.handle(str(message.topic), payload)
                        except Exception:
                            log.exception("Handling MQTT message on %s failed", message.topic)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if self.connected or self.last_error != str(exc):
                    log.warning("MQTT: %s; retrying in %.0f s", exc, backoff)
                self.last_error = str(exc) or type(exc).__name__
            self.connected = False
            self.link = None
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60.0)

    def status(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled(),
            "connected": self.connected,
            "broker": self.broker,
            "last_error": self.last_error,
        }


class _AioLink:
    def __init__(self, client: Any) -> None:
        self.client = client

    async def publish(self, topic: str, payload: str, retain: bool) -> None:
        await self.client.publish(topic, payload, qos=1, retain=retain)
