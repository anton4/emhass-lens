"""Price forecasts: eupowerprices.com polling (with backoff) and the FI forecast entity."""

import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

import httpx

from emhass_lens.clients.eupowerprices import fetch_latest
from emhass_lens.core.clock import iso, parse_iso
from emhass_lens.domain.forecast import ee_eupowerprices, fi_ha_entity
from emhass_lens.domain.forecast.base import ForecastPoint, ForecastSeries
from emhass_lens.scheduler.core import JobContext

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.forecast")

BACKOFF_MIN = (5, 10, 20, 40)
KEEP_DAYS = 30
POLLED_KEY = "forecast.{provider}.polled"  # the real poll times (fetched_at only says when content first appeared)


@dataclass
class ProviderStatus:
    last_attempt: datetime | None = None
    last_success: datetime | None = None
    http_status: int | None = None
    error: str | None = None
    consecutive_errors: int = 0
    points: int = 0


class ForecastService:
    def __init__(self, c: Container, http: httpx.AsyncClient) -> None:
        self.c = c
        self.http = http
        self.latest: dict[str, ForecastSeries] = {}
        self.status_by_provider: dict[str, ProviderStatus] = {
            ee_eupowerprices.PROVIDER: ProviderStatus(),
            fi_ha_entity.PROVIDER: ProviderStatus(),
        }

    @property
    def source(self) -> str:
        return self.c.settings.current.forecast.source

    def load(self) -> None:
        """Restore each provider's newest stored forecast and poll times, so a restart neither loses the forecast
        nor fetches it again before it is due. A series that has already run out is left to the next poll."""
        now = self.c.clock.now()
        for provider, st in self.status_by_provider.items():
            saved = self.c.kv_get(POLLED_KEY.format(provider=provider)) or {}
            head = self.c.app_db.query_one(
                "SELECT id, fetched_at, issued_at, meta_json FROM forecast_snapshot WHERE provider = ? "
                "ORDER BY id DESC LIMIT 1",
                (provider,),
            )
            fetched_at = parse_iso(head["fetched_at"]) if head else None
            st.last_attempt = parse_iso(saved.get("last_attempt")) or fetched_at
            st.last_success = parse_iso(saved.get("last_success")) or fetched_at
            st.http_status = saved.get("http_status")
            st.error = saved.get("error")
            st.consecutive_errors = int(saved.get("consecutive_errors") or 0)
            if head is None or fetched_at is None:
                continue
            points = tuple(
                ForecastPoint(a, b, float(r["eur_mwh"]))
                for r in self.c.app_db.query(
                    "SELECT start_utc, end_utc, eur_mwh FROM forecast_point WHERE snapshot_id = ? ORDER BY start_utc",
                    (head["id"],),
                )
                if (a := parse_iso(r["start_utc"])) is not None and (b := parse_iso(r["end_utc"])) is not None
            )
            if not points:
                continue
            series = ForecastSeries(
                provider, points, fetched_at, parse_iso(head["issued_at"]), json.loads(head["meta_json"] or "{}")
            )
            st.points = len(points)
            if series.end is not None and series.end > now:
                self.latest[provider] = series
                log.info(
                    "Price forecast restored: %s, %d points until %s UTC, fetched %s",
                    provider,
                    len(points),
                    f"{series.end:%Y-%m-%d %H:%M}",
                    iso(st.last_success),
                )

    def _remember(self, provider: str) -> None:
        """Persist the poll times and the last error (worker thread), for load() after a restart."""
        st = self.status_by_provider[provider]
        self.c.kv_set(
            POLLED_KEY.format(provider=provider),
            {
                "last_attempt": iso(st.last_attempt),
                "last_success": iso(st.last_success),
                "http_status": st.http_status,
                "error": st.error,
                "consecutive_errors": st.consecutive_errors,
            },
        )

    def current(self) -> ForecastSeries | None:
        """The forecast of the selected source, if any."""
        if self.source == "none":
            return None
        return self.latest.get(self.source)

    # --- eupowerprices.com ------------------------------------------------------------------------
    def next_ee_poll(self, after: datetime) -> datetime | None:
        settings = self.c.settings.current.forecast
        if settings.source != ee_eupowerprices.PROVIDER or not settings.ee.api_key:
            return None
        st = self.status_by_provider[ee_eupowerprices.PROVIDER]
        interval = timedelta(hours=settings.ee.poll_hours)
        if st.last_attempt is None:
            return after + timedelta(seconds=5)
        if st.consecutive_errors:
            wait = timedelta(minutes=BACKOFF_MIN[min(st.consecutive_errors, len(BACKOFF_MIN)) - 1])
            return max(st.last_attempt + min(wait, interval), after + timedelta(seconds=1))
        return max((st.last_success or st.last_attempt) + interval, after + timedelta(seconds=1))

    async def poll_ee(self, ctx: JobContext) -> None:
        settings = self.c.settings.current.forecast
        if settings.source != ee_eupowerprices.PROVIDER:
            if ctx.run:
                ctx.run.outcome, ctx.run.summary = "noop", "eupowerprices.com isn't the selected forecast"
            return
        now = self.c.clock.now()
        st = self.status_by_provider[ee_eupowerprices.PROVIDER]
        st.last_attempt = now
        fetched = await fetch_latest(self.http, settings.ee.api_key, now)
        st.http_status = fetched.http_status
        if fetched.error or fetched.series is None:
            st.error = fetched.error
            st.consecutive_errors += 1
            log.warning("eupowerprices.com forecast failed: %s", fetched.error)
            if ctx.run:
                ctx.run.outcome, ctx.run.error = "error", fetched.error
        else:
            st.error, st.consecutive_errors, st.last_success = None, 0, now
            st.points = len(fetched.series.points)
            self.latest[ee_eupowerprices.PROVIDER] = fetched.series
            stored = await self.c.app_db.run(self._store, fetched.series)
            first, last = fetched.series.points[0], fetched.series.points[-1]
            summary = f"{st.points} points {first.start:%Y-%m-%d %H:%M} → {last.end:%Y-%m-%d %H:%M} UTC" + (
                "" if stored else " (unchanged)"
            )
            log.info("eupowerprices.com forecast: %s", summary)
            if ctx.run:
                ctx.run.summary = summary
                ctx.run.artifact("forecast", _series_dict(fetched.series))
        await self.c.app_db.run(self._remember, ee_eupowerprices.PROVIDER)
        self.c.scheduler.retime("forecast.ee.poll")

    # --- FI forecast from Home Assistant ----------------------------------------------------------
    def fi_entity(self) -> str:
        return self.c.settings.current.forecast.fi.entity

    async def on_fi_state(self, entity_id: str, state: dict[str, Any] | None) -> None:
        fi = self.c.settings.current.forecast.fi
        st = self.status_by_provider[fi_ha_entity.PROVIDER]
        now = self.c.clock.now()
        st.last_attempt = now
        if state is None:
            st.error, st.points = f"{entity_id} not found", 0
            self.latest.pop(fi_ha_entity.PROVIDER, None)
            return
        attr = (state.get("attributes") or {}).get(fi.attribute)
        series = fi_ha_entity.parse(attr, fi.unit, fi.vat_included_pct, now, entity_id)
        if not series.points:
            st.error, st.points = f"{entity_id} has no '{fi.attribute}' list", 0
            self.latest.pop(fi_ha_entity.PROVIDER, None)
            return
        st.error, st.last_success, st.points = None, now, len(series.points)
        self.latest[fi_ha_entity.PROVIDER] = series
        if await self.c.app_db.run(self._store, series):
            log.info("FI forecast updated from %s: %d points", entity_id, st.points)
        await self.c.app_db.run(self._remember, fi_ha_entity.PROVIDER)

    # --- storage ------------------------------------------------------------------------------------
    def _store(self, series: ForecastSeries) -> bool:
        """Store a snapshot if it differs from the provider's previous one. Runs in a worker thread."""
        digest = hashlib.sha256(
            json.dumps([(iso(p.start), round(p.eur_mwh, 4)) for p in series.points]).encode()
        ).hexdigest()[:16]
        prev = self.c.app_db.query_one(
            "SELECT digest FROM forecast_snapshot WHERE provider = ? ORDER BY id DESC LIMIT 1", (series.provider,)
        )
        if prev and prev["digest"] == digest:
            return False

        def write(conn: Any) -> None:
            cur = conn.execute(
                "INSERT INTO forecast_snapshot (provider, fetched_at, issued_at, digest, meta_json) VALUES (?,?,?,?,?)",
                (
                    series.provider,
                    iso(series.fetched_at),
                    iso(series.issued_at),
                    digest,
                    json.dumps(series.meta, default=str),
                ),
            )
            conn.executemany(
                "INSERT OR REPLACE INTO forecast_point (snapshot_id, start_utc, end_utc, eur_mwh) VALUES (?,?,?,?)",
                [(cur.lastrowid, iso(p.start), iso(p.end), p.eur_mwh) for p in series.points],
            )

        self.c.app_db.transaction(write)
        return True

    def prune(self, now: datetime) -> int:
        cut = iso(now - timedelta(days=KEEP_DAYS))
        return self.c.app_db.execute("DELETE FROM forecast_snapshot WHERE fetched_at < ?", (cut,)).rowcount

    def status(self) -> dict[str, Any]:
        out: dict[str, Any] = {"source": self.source, "providers": {}}
        for provider, st in self.status_by_provider.items():
            series = self.latest.get(provider)
            out["providers"][provider] = {
                "last_attempt": iso(st.last_attempt),
                "last_success": iso(st.last_success),
                "http_status": st.http_status,
                "error": st.error,
                "consecutive_errors": st.consecutive_errors,
                "points": st.points,
                "start": iso(series.points[0].start) if series and series.points else None,
                "end": iso(series.end) if series else None,
                "issued_at": iso(series.issued_at) if series else None,
            }
        return out


def _series_dict(series: ForecastSeries) -> dict[str, Any]:
    return {
        "provider": series.provider,
        "fetched_at": iso(series.fetched_at),
        "issued_at": iso(series.issued_at),
        "meta": series.meta,
        "points": [{"start": iso(p.start), "end": iso(p.end), "eur_mwh": p.eur_mwh} for p in series.points],
    }
