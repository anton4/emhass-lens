"""Supervisor API (only available when running as a Home Assistant App)."""

from typing import Any

import httpx

from emhass_lens.clients.http import make_client


class SupervisorError(Exception):
    pass


class SupervisorClient:
    def __init__(self, base_url: str, token: str | None, transport: Any = None) -> None:
        self.available = bool(token)
        self.client = make_client(
            "supervisor",
            base_url=base_url,
            headers={"Authorization": f"Bearer {token}"} if token else {},
            transport=transport,
        )

    async def _call(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        if not self.available:
            raise SupervisorError("not running under the Supervisor")
        try:
            resp = await self.client.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise SupervisorError(str(exc) or type(exc).__name__) from exc
        try:
            body = resp.json()
        except ValueError:
            body = {}
        if resp.status_code >= 400 or body.get("result") == "error":
            raise SupervisorError(body.get("message") or f"Supervisor returned {resp.status_code}")
        return body.get("data") or {}

    async def addons(self) -> list[dict[str, Any]]:
        return (await self._call("GET", "/addons")).get("addons") or []

    async def addon_info(self, slug: str) -> dict[str, Any]:
        return await self._call("GET", f"/addons/{slug}/info")

    async def mqtt_service(self) -> dict[str, Any]:
        return await self._call("GET", "/services/mqtt")

    async def self_info(self) -> dict[str, Any]:
        return await self._call("GET", "/addons/self/info")

    async def backups(self) -> list[dict[str, Any]]:
        """Every backup the Supervisor knows (needs hassio_role: backup)."""
        return (await self._call("GET", "/backups")).get("backups") or []

    async def close(self) -> None:
        await self.client.aclose()


def addon_hostname(slug: str) -> str:
    return slug.replace("_", "-")
