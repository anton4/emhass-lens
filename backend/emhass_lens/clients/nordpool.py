"""Fetches one Nord Pool delivery day."""

import time
from dataclasses import dataclass
from datetime import date

import httpx

from emhass_lens.clients.http import describe_error
from emhass_lens.domain import nordpool


@dataclass(frozen=True)
class NordpoolFetch:
    day: date
    http_status: int | None
    result: nordpool.DeliveryDay | None
    not_published: bool
    error: str | None
    duration_ms: int

    @property
    def ok(self) -> bool:
        return self.error is None


async def fetch_day(client: httpx.AsyncClient, day: date, area: str) -> NordpoolFetch:
    started = time.monotonic()

    def done(status: int | None, result=None, not_published=False, error=None) -> NordpoolFetch:
        return NordpoolFetch(day, status, result, not_published, error, int((time.monotonic() - started) * 1000))

    try:
        resp = await client.get(nordpool.API_URL, params=nordpool.request_params(day, area))
    except httpx.HTTPError as exc:
        return done(None, error=describe_error(exc))
    # 204 = the day exists but has no results yet; 400/404 were seen before publication too
    if resp.status_code in (204, 400, 404):
        return done(resp.status_code, not_published=True)
    if resp.status_code != 200:
        return done(resp.status_code, error=f"HTTP {resp.status_code}")
    try:
        body = resp.json()
    except ValueError:
        return done(resp.status_code, error="response is not JSON")
    parsed = nordpool.parse(body, day, area)
    if not parsed.entries:
        return done(resp.status_code, result=parsed, not_published=True)
    return done(resp.status_code, result=parsed)
