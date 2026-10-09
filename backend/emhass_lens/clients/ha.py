"""Home Assistant client: REST for one-off calls, a WebSocket for live state of watched entities.

Through the Supervisor the base URL is http://supervisor/core (token: SUPERVISOR_TOKEN); standalone
it's the HA URL with a long-lived access token. The WebSocket reconnects with backoff; every
(re)connect re-reads the watched states and notifies listeners, which is also how an HA restart
is noticed (outputs re-publish then).
"""

import asyncio
import contextlib
import json
import logging
import random
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any

import httpx
import websockets
from websockets.asyncio.client import ClientConnection

from emhass_lens.clients.http import describe_error, make_client
from emhass_lens.core.bus import EventBus
from emhass_lens.core.clock import Clock, iso

log = logging.getLogger("emhass_lens.ha")

StateListener = Callable[[str, dict[str, Any] | None], Awaitable[None] | None]
ConnectListener = Callable[[], Awaitable[None] | None]


def ws_url(base_url: str) -> str:
    base = base_url.rstrip("/")
    if base == "http://supervisor/core":
        return "ws://supervisor/core/websocket"
    return base.replace("https://", "wss://", 1).replace("http://", "ws://", 1) + "/api/websocket"


class HaError(Exception):
    pass


class HaClient:
    def __init__(self, base_url: str, token: str | None, clock: Clock, bus: EventBus, transport: Any = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.clock = clock
        self.bus = bus
        self.rest = make_client("ha", base_url=self.base_url, headers=self._auth(), timeout=20, transport=transport)
        self.watched: set[str] = set()
        self.states: dict[str, dict[str, Any]] = {}
        self.connected = False
        self.connected_since: datetime | None = None
        self.last_error: str | None = None
        self.disconnected_since: datetime | None = clock.now()
        self.ha_version: str | None = None
        self.time_zone: str | None = None
        self.location_name: str | None = None
        self._state_listeners: list[tuple[Callable[[str], bool], StateListener]] = []
        self._connect_listeners: list[ConnectListener] = []
        self._task: asyncio.Task[None] | None = None
        self._ws: ClientConnection | None = None
        self._next_id = 1
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._background: set[asyncio.Task[None]] = set()

    def _auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    @property
    def configured(self) -> bool:
        return bool(self.token)

    # --- lifecycle ---------------------------------------------------------------------------------
    def start(self) -> None:
        if self._task is None and self.configured:
            self._task = asyncio.create_task(self._run(), name="ha-websocket")
        elif not self.configured:
            self.last_error = "No Home Assistant token (standalone: set HA_URL and HA_TOKEN)"
            log.warning(self.last_error)

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        await self.rest.aclose()

    # --- watching ----------------------------------------------------------------------------------
    def set_watched(self, entity_ids: set[str]) -> asyncio.Task[None] | None:
        """Watch these entities; returns the task loading newly added ones (None if nothing to load)."""
        added = {e for e in entity_ids if e} - self.watched
        self.watched = {e for e in entity_ids if e}
        for entity_id in list(self.states):
            if entity_id not in self.watched:
                del self.states[entity_id]
        if added and self.connected:
            task = asyncio.create_task(self._refresh(added))
            self._background.add(task)
            task.add_done_callback(self._background.discard)
            return task
        return None

    def on_state(self, predicate: Callable[[str], bool], listener: StateListener) -> None:
        self._state_listeners.append((predicate, listener))

    def on_connect(self, listener: ConnectListener) -> None:
        self._connect_listeners.append(listener)

    def state(self, entity_id: str) -> dict[str, Any] | None:
        return self.states.get(entity_id)

    # --- REST ------------------------------------------------------------------------------------------
    async def get_state(self, entity_id: str) -> dict[str, Any] | None:
        resp = await self.rest.get(f"/api/states/{entity_id}")
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()

    async def get_states(self) -> list[dict[str, Any]]:
        resp = await self.rest.get("/api/states")
        resp.raise_for_status()
        return resp.json()

    async def get_config(self) -> dict[str, Any]:
        resp = await self.rest.get("/api/config")
        resp.raise_for_status()
        return resp.json()

    async def call_service(self, domain: str, service: str, data: dict[str, Any] | None = None) -> Any:
        resp = await self.rest.post(f"/api/services/{domain}/{service}", json=data or {})
        if resp.status_code >= 400:
            raise HaError(f"{domain}.{service} failed: HTTP {resp.status_code} {resp.text[:200]}")
        return resp.json() if resp.content else None

    async def fire_event(self, event_type: str, data: dict[str, Any]) -> None:
        resp = await self.rest.post(f"/api/events/{event_type}", json=data)
        if resp.status_code >= 400:
            raise HaError(f"firing {event_type} failed: HTTP {resp.status_code}")

    async def post(self, path: str, payload: dict[str, Any]) -> httpx.Response:
        return await self.rest.post(path, json=payload)

    async def delete(self, path: str) -> httpx.Response:
        return await self.rest.delete(path)

    # --- WebSocket ------------------------------------------------------------------------------------
    async def ws_command(self, payload: dict[str, Any], timeout: float = 20) -> Any:
        if self._ws is None:
            raise HaError("not connected to Home Assistant")
        msg_id = self._next_id
        self._next_id += 1
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = future
        await self._ws.send(json.dumps({"id": msg_id, **payload}))
        try:
            async with asyncio.timeout(timeout):
                return await future
        finally:
            self._pending.pop(msg_id, None)

    async def _run(self) -> None:
        backoff = 1.0
        while True:
            try:
                await self._session()
                backoff = 1.0
                self.last_error = "connection closed by Home Assistant (restarting?)"
                log.warning("Home Assistant closed the connection; reconnecting")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.last_error = (
                    describe_error(exc) if isinstance(exc, httpx.HTTPError) else str(exc) or type(exc).__name__
                )
                if self.connected:
                    log.warning("Lost the Home Assistant connection: %s", self.last_error)
                else:
                    log.info("Can't reach Home Assistant yet (%s); retrying in %.0f s", self.last_error, backoff)
            self._mark_disconnected()
            await asyncio.sleep(backoff + random.uniform(0, backoff / 4))
            backoff = min(backoff * 2, 30.0)

    async def _session(self) -> None:
        async with websockets.connect(ws_url(self.base_url), max_size=64 * 1024 * 1024, ping_interval=30) as ws:
            hello = json.loads(await ws.recv())
            if hello.get("type") != "auth_required":
                raise HaError(f"unexpected greeting {hello.get('type')}")
            await ws.send(json.dumps({"type": "auth", "access_token": self.token}))
            auth = json.loads(await ws.recv())
            if auth.get("type") != "auth_ok":
                raise HaError(f"authentication failed: {auth.get('message') or auth.get('type')}")
            self.ha_version = auth.get("ha_version")
            self._ws = ws
            reader = asyncio.create_task(self._reader(ws), name="ha-ws-reader")
            try:
                config = await self.ws_command({"type": "get_config"})
                self.time_zone = config.get("time_zone")
                self.location_name = config.get("location_name")
                await self.ws_command({"type": "subscribe_events", "event_type": "state_changed"})
                await self._refresh(self.watched)
                self.connected = True
                self.connected_since = self.clock.now()
                self.disconnected_since = None
                self.last_error = None
                log.info("Connected to Home Assistant %s (%s, %s)", self.ha_version, self.location_name, self.time_zone)
                self.bus.publish("ha.connected", {"ha_version": self.ha_version, "at": iso(self.connected_since)})
                for listener in self._connect_listeners:
                    await _maybe_await(listener())
                await reader
            finally:
                reader.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await reader
                self._ws = None
                for future in self._pending.values():
                    if not future.done():
                        future.set_exception(HaError("connection closed"))
                self._pending.clear()

    async def _reader(self, ws: ClientConnection) -> None:
        async for raw in ws:
            msg = json.loads(raw)
            kind = msg.get("type")
            if kind == "result":
                future = self._pending.get(msg.get("id"))
                if future and not future.done():
                    if msg.get("success"):
                        future.set_result(msg.get("result"))
                    else:
                        error = msg.get("error") or {}
                        future.set_exception(HaError(error.get("message") or "command failed"))
            elif kind == "event":
                event = msg.get("event") or {}
                if event.get("event_type") == "state_changed":
                    data = event.get("data") or {}
                    entity_id = data.get("entity_id")
                    if entity_id in self.watched:
                        await self._set_state(entity_id, data.get("new_state"))

    async def _refresh(self, entity_ids: set[str]) -> None:
        """Re-read watched states (all at once; cheap compared with one request per entity)."""
        if not entity_ids:
            return
        try:
            states = await self.ws_command({"type": "get_states"}, timeout=60)
        except Exception as exc:
            log.warning("Reading entity states failed: %s", exc)
            return
        by_id = {s["entity_id"]: s for s in states}
        for entity_id in entity_ids:
            await self._set_state(entity_id, by_id.get(entity_id))

    async def _set_state(self, entity_id: str, state: dict[str, Any] | None) -> None:
        if state is None:
            self.states.pop(entity_id, None)
        else:
            self.states[entity_id] = state
        for predicate, listener in self._state_listeners:
            if predicate(entity_id):
                try:
                    await _maybe_await(listener(entity_id, state))
                except Exception:
                    log.exception("State listener failed for %s", entity_id)

    def _mark_disconnected(self) -> None:
        if self.connected:
            self.bus.publish("ha.disconnected", {"error": self.last_error})
        self.connected = False
        if self.disconnected_since is None:
            self.disconnected_since = self.clock.now()

    def status(self) -> dict[str, Any]:
        return {
            "configured": self.configured,
            "connected": self.connected,
            "connected_since": iso(self.connected_since),
            "disconnected_since": iso(self.disconnected_since),
            "ha_version": self.ha_version,
            "time_zone": self.time_zone,
            "last_error": self.last_error,
            "watched": len(self.watched),
        }


async def _maybe_await(value: Any) -> None:
    if asyncio.iscoroutine(value) or isinstance(value, asyncio.Future):
        await value
