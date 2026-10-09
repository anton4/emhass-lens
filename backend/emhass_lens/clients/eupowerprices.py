"""eupowerprices.com forecast API."""

import time
from dataclasses import dataclass
from datetime import datetime

import httpx

from emhass_lens.clients.http import describe_error
from emhass_lens.domain.forecast import ee_eupowerprices
from emhass_lens.domain.forecast.base import ForecastSeries


@dataclass(frozen=True)
class ForecastFetch:
    http_status: int | None
    series: ForecastSeries | None
    error: str | None
    duration_ms: int


async def fetch_latest(client: httpx.AsyncClient, api_key: str, now: datetime) -> ForecastFetch:
    started = time.monotonic()
    try:
        resp = await client.get(ee_eupowerprices.URL, headers={"X-API-Key": api_key})
    except httpx.HTTPError as exc:
        return ForecastFetch(None, None, describe_error(exc), int((time.monotonic() - started) * 1000))
    ms = int((time.monotonic() - started) * 1000)
    if resp.status_code != 200:
        hint = {401: " (check the API key)", 403: " (check the API key)", 429: " (rate limited)"}.get(
            resp.status_code, ""
        )
        return ForecastFetch(resp.status_code, None, f"HTTP {resp.status_code}{hint}", ms)
    try:
        series = ee_eupowerprices.parse(resp.json(), now)
    except (ValueError, KeyError, TypeError) as exc:
        return ForecastFetch(resp.status_code, None, f"unexpected response: {exc}", ms)
    if not series.points:
        return ForecastFetch(resp.status_code, series, "the forecast has no points", ms)
    return ForecastFetch(resp.status_code, series, None, ms)
