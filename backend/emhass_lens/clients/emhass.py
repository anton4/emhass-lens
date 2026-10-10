"""EMHASS REST API: health, last run, plan, effective config and actions."""

import json
import time
from dataclasses import dataclass
from typing import Any

import httpx

from emhass_lens.clients.http import describe_error, make_client
from emhass_lens.core.redact import redactor


@dataclass(frozen=True)
class ActionResult:
    action: str
    http_status: int | None
    body: str
    error: str | None
    error_lines: list[str]
    duration_ms: int

    @property
    def ok(self) -> bool:
        return self.error is None


class EmhassError(Exception):
    pass


class EmhassClient:
    def __init__(self, transport: Any = None) -> None:
        self.base_url = ""
        self.client = make_client("emhass", timeout=30, transport=transport)

    def set_base_url(self, url: str) -> None:
        self.base_url = url.rstrip("/")

    def _url(self, path: str) -> str:
        if not self.base_url:
            raise EmhassError("the EMHASS address is not known yet")
        return f"{self.base_url}{path}"

    async def _get_json(self, path: str, timeout: float = 15) -> Any:
        try:
            resp = await self.client.get(self._url(path), timeout=timeout)
        except httpx.HTTPError as exc:
            raise EmhassError(describe_error(exc)) from exc
        if resp.status_code >= 400 and resp.status_code != 503:
            raise EmhassError(f"GET {path}: HTTP {resp.status_code}")
        try:
            return resp.json()
        except ValueError as exc:
            raise EmhassError(f"GET {path}: response is not JSON") from exc

    async def healthz(self) -> dict[str, Any]:
        return await self._get_json("/healthz")

    async def last_run(self) -> dict[str, Any]:
        return await self._get_json("/api/v1/last-run")

    async def plan(self) -> dict[str, Any]:
        return await self._get_json("/api/v1/plan", timeout=30)

    async def get_config(self) -> dict[str, Any]:
        return await self._get_json("/get-config", timeout=30)

    async def probe(self, url: str) -> dict[str, Any]:
        """healthz of an arbitrary candidate URL (for discovery)."""
        resp = await self.client.get(f"{url.rstrip('/')}/healthz", timeout=5)
        if resp.status_code not in (200, 503):
            raise EmhassError(f"HTTP {resp.status_code}")
        return resp.json()

    async def action(self, name: str, payload: dict[str, Any], timeout: float) -> ActionResult:
        started = time.monotonic()
        try:
            resp = await self.client.post(self._url(f"/action/{name}"), json=payload, timeout=timeout)
        except httpx.HTTPError as exc:
            return ActionResult(name, None, "", describe_error(exc), [], int((time.monotonic() - started) * 1000))
        ms = int((time.monotonic() - started) * 1000)
        body = redactor.text(resp.text)
        error_lines = [line for line in body_lines(body) if "ERROR" in line]
        error = None
        if resp.status_code >= 400:
            error = f"HTTP {resp.status_code}" + (f": {error_lines[-1].strip()}" if error_lines else "")
        return ActionResult(name, resp.status_code, body, error, error_lines, ms)

    async def close(self) -> None:
        await self.client.aclose()


def body_lines(body: str) -> list[str]:
    """The lines of an action's response. EMHASS answers a failed action with its log as a JSON list of strings
    on one line; anything else is split on newlines."""
    text = body.strip()
    if text.startswith("["):
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = None
        if isinstance(parsed, list) and all(isinstance(item, str) for item in parsed):
            return [line for item in parsed for line in item.splitlines()]
    return body.splitlines()
