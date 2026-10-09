"""Nord Pool prices: polling per delivery day, storage, and priced 15-minute series."""

import logging
from datetime import UTC, date, datetime, time, timedelta
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

import httpx

from emhass_lens.clients.nordpool import NordpoolFetch, fetch_day
from emhass_lens.core.clock import iso, parse_iso
from emhass_lens.domain import nordpool
from emhass_lens.domain.forecast.base import ForecastSeries
from emhass_lens.domain.forecast.stitch import Stitched, stitch
from emhass_lens.domain.poll_policy import DayState, PollConfig, PollDecision, decide, needed_days
from emhass_lens.domain.tariffs.engine import SlotPrice, network_rates, price_slot
from emhass_lens.scheduler.core import JobContext
from emhass_lens.settings.model import Settings

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.prices")

AREA_TZ = {"EE": "Europe/Tallinn", "FI": "Europe/Helsinki", "LV": "Europe/Riga", "LT": "Europe/Vilnius"}
KEEP_DAYS = 120


def area_tz(settings: Settings) -> ZoneInfo:
    return ZoneInfo(AREA_TZ.get(settings.prices.nordpool.area, "Europe/Tallinn"))


def _hhmm(value: str) -> time:
    h, m = value.split(":")
    return time(int(h), int(m))


class PriceService:
    def __init__(self, c: Container, http: httpx.AsyncClient) -> None:
        self.c = c
        self.http = http
        self.states: dict[date, DayState] = {}
        self.day_info: dict[date, dict[str, Any]] = {}
        self.version = 0  # bumps whenever stored prices change
        self._cache: dict[tuple[str, str], list[nordpool.PriceEntry]] = {}

    # --- configuration -----------------------------------------------------------------------------
    @property
    def settings(self) -> Settings:
        return self.c.settings.current

    @property
    def area(self) -> str:
        return self.settings.prices.nordpool.area

    @property
    def tz(self) -> ZoneInfo:
        return area_tz(self.settings)

    def poll_config(self) -> PollConfig:
        np = self.settings.prices.nordpool
        return PollConfig(
            publish_time=_hhmm(np.publish_time),
            fast_until=_hhmm(np.fast_until),
            fast_interval=timedelta(minutes=np.fast_interval_min),
            slow_interval=timedelta(minutes=np.slow_interval_min),
        )

    # --- state -----------------------------------------------------------------------------------------
    def load(self) -> None:
        self.states.clear()
        self.day_info.clear()
        for row in self.c.app_db.query("SELECT * FROM price_day WHERE area = ?", (self.area,)):
            day = date.fromisoformat(row["day"])
            self.states[day] = DayState(
                day=day,
                state=row["state"],
                slots=row["slots"],
                last_attempt=parse_iso(row["last_attempt"]),
                last_success=parse_iso(row["last_success"]),
                consecutive_errors=row["consecutive_errors"],
                not_published=bool(row["not_published"]),
            )
            self.day_info[day] = row
        self.version += 1
        self._cache.clear()

    def decisions(self, now: datetime | None = None) -> list[PollDecision]:
        return decide(now or self.c.clock.now(), self.tz, self.states, self.poll_config())

    def next_poll(self, after: datetime) -> datetime:
        decisions = self.decisions(after)
        if not decisions:
            return after + timedelta(minutes=15)  # re-evaluate (a new day becomes "needed" at midnight)
        due = decisions[0].due_at
        return max(due, after + timedelta(seconds=1))

    # --- polling job ------------------------------------------------------------------------------------
    async def poll(self, ctx: JobContext) -> None:
        now = self.c.clock.now()
        force = ctx.trigger == "manual"
        decisions = self.decisions(now)
        due = decisions if force else [d for d in decisions if d.due_at <= now]
        if force:
            due = [PollDecision(day, now, "manual refresh") for day in needed_days(now, self.tz)]
        results = []
        for decision in due:
            log.info("Fetching Nord Pool %s delivery day %s: %s", self.area, decision.day, decision.reason)
            fetched = await fetch_day(self.http, decision.day, self.area)
            prev = self.states.get(fetched.day, DayState(fetched.day))
            state, info = await self.c.app_db.run(self._store, fetched, now, prev)
            self.states[fetched.day] = state
            self.day_info[fetched.day] = info
            results.append(self._describe(fetched))
            if ctx.run:
                ctx.run.artifact(f"fetch {decision.day}", self._describe(fetched))
        self.version += 1
        self._cache.clear()
        if ctx.run:
            pending = self.decisions(self.c.clock.now())
            ctx.run.artifact(
                "next", [{"day": d.day.isoformat(), "due_at": iso(d.due_at), "reason": d.reason} for d in pending]
            )
            if not due:
                ctx.run.outcome = "noop"
                ctx.run.summary = "Nothing due"
            else:
                ctx.run.summary = "; ".join(r["summary"] for r in results)
                if any(r["error"] for r in results):
                    ctx.run.outcome = "error"
                    ctx.run.error = "; ".join(r["error"] for r in results if r["error"])
        self.c.scheduler.retime("nordpool.poll")

    @staticmethod
    def _describe(f: NordpoolFetch) -> dict[str, Any]:
        if f.error:
            summary = f"{f.day}: {f.error}"
        elif f.not_published:
            summary = f"{f.day}: not published yet (HTTP {f.http_status})"
        else:
            assert f.result is not None
            summary = f"{f.day}: {len(f.result.entries)} prices, {f.result.state}"
        return {
            "day": f.day.isoformat(),
            "http_status": f.http_status,
            "error": f.error,
            "not_published": f.not_published,
            "duration_ms": f.duration_ms,
            "summary": summary,
            "state": f.result.state if f.result else None,
            "entries": len(f.result.entries) if f.result else 0,
            "resolution_min": f.result.resolution_min if f.result else None,
            "updated_at": f.result.updated_at if f.result else None,
        }

    def _store(self, f: NordpoolFetch, now: datetime, prev: DayState) -> tuple[DayState, dict[str, Any]]:
        """Runs in a worker thread: writes the fetch outcome, returns the new day state."""
        if f.error:
            state = DayState(
                f.day, prev.state, prev.slots, now, prev.last_success, prev.consecutive_errors + 1, prev.not_published
            )
            row = {"http_status": f.http_status, "error": f.error}
        elif f.not_published or f.result is None:
            state = DayState(f.day, prev.state, prev.slots, now, prev.last_success, 0, prev.slots == 0)
            row = {"http_status": f.http_status, "error": None}
        else:
            quarters = nordpool.to_quarter_hours(f.result.entries)

            def write(conn: Any) -> None:
                conn.execute("DELETE FROM price_slot WHERE area = ? AND day = ?", (self.area, f.day.isoformat()))
                conn.executemany(
                    "INSERT OR REPLACE INTO price_slot (area, start_utc, end_utc, day, eur_mwh) VALUES (?,?,?,?,?)",
                    [(self.area, iso(q.start), iso(q.end), f.day.isoformat(), q.eur_mwh) for q in quarters],
                )

            self.c.app_db.transaction(write)
            state = DayState(f.day, f.result.state, len(quarters), now, now, 0, False)
            row = {
                "http_status": f.http_status,
                "error": None,
                "resolution_min": f.result.resolution_min,
                "updated_at": f.result.updated_at,
            }
        self.c.app_db.execute(
            "INSERT INTO price_day (area, day, state, slots, resolution_min, updated_at, last_attempt, last_success, "
            "http_status, error, consecutive_errors, not_published) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(area, day) DO UPDATE SET state=excluded.state, slots=excluded.slots, "
            "resolution_min=COALESCE(excluded.resolution_min, price_day.resolution_min), "
            "updated_at=COALESCE(excluded.updated_at, price_day.updated_at), last_attempt=excluded.last_attempt, "
            "last_success=excluded.last_success, http_status=excluded.http_status, error=excluded.error, "
            "consecutive_errors=excluded.consecutive_errors, not_published=excluded.not_published",
            (
                self.area,
                f.day.isoformat(),
                state.state,
                state.slots,
                row.get("resolution_min"),
                row.get("updated_at"),
                iso(state.last_attempt),
                iso(state.last_success),
                row.get("http_status"),
                row.get("error"),
                state.consecutive_errors,
                int(state.not_published),
            ),
        )
        info = self.c.app_db.query_one(
            "SELECT * FROM price_day WHERE area = ? AND day = ?", (self.area, f.day.isoformat())
        )
        return state, info or {}

    def prune(self, now: datetime) -> int:
        cut = (now - timedelta(days=KEEP_DAYS)).date().isoformat()
        removed = self.c.app_db.execute("DELETE FROM price_slot WHERE day < ?", (cut,)).rowcount
        self.c.app_db.execute("DELETE FROM price_day WHERE day < ?", (cut,))
        return removed

    # --- reading ----------------------------------------------------------------------------------------
    def entries(self, start: datetime, end: datetime) -> list[nordpool.PriceEntry]:
        key = (iso(start) or "", iso(end) or "")
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        rows = self.c.app_db.query(
            "SELECT start_utc, end_utc, eur_mwh FROM price_slot WHERE area = ? AND start_utc >= ? AND start_utc < ? "
            "ORDER BY start_utc",
            (self.area, iso(start), iso(end)),
        )
        entries = [
            nordpool.PriceEntry(parse_iso(r["start_utc"]) or start, parse_iso(r["end_utc"]) or start, r["eur_mwh"])
            for r in rows
        ]
        if len(self._cache) > 32:
            self._cache.clear()
        self._cache[key] = entries
        return entries

    def stitched(self, start: datetime, forecast: ForecastSeries | None) -> Stitched:
        settings = self.settings
        extend = settings.forecast.extend_days if settings.forecast.source != "none" else 0
        end = start + timedelta(days=4 + extend)
        return stitch(self.entries(start, end), forecast, extend)

    def priced(
        self,
        start: datetime,
        forecast: ForecastSeries | None,
        *,
        legacy_compat: bool = False,
        settings: Settings | None = None,
    ) -> list[SlotPrice]:
        settings = settings or self.settings
        tariff = settings.prices.tariff
        rates = network_rates(tariff)
        tz = area_tz(settings)
        return [
            price_slot(s.eur_mwh, s.start, s.end, tariff, tz, s.origin, rates, legacy_compat)
            for s in self.stitched(start, forecast).slots
        ]

    def status(self) -> dict[str, Any]:
        now = self.c.clock.now()
        days = []
        for day in sorted(set(self.states) | set(needed_days(now, self.tz))):
            info = self.day_info.get(day) or {}
            st = self.states.get(day, DayState(day))
            days.append(
                {
                    "day": day.isoformat(),
                    "state": st.state,
                    "slots": st.slots,
                    "last_attempt": iso(st.last_attempt),
                    "last_success": iso(st.last_success),
                    "consecutive_errors": st.consecutive_errors,
                    "not_published": st.not_published,
                    "http_status": info.get("http_status"),
                    "error": info.get("error"),
                    "resolution_min": info.get("resolution_min"),
                    "updated_at": info.get("updated_at"),
                }
            )
        decisions = [
            {"day": d.day.isoformat(), "due_at": iso(d.due_at), "reason": d.reason} for d in self.decisions(now)
        ]
        return {"area": self.area, "timezone": str(self.tz), "days": days[-6:], "next": decisions}


def utc_day_start(local_day: date, tz: ZoneInfo) -> datetime:
    return datetime.combine(local_day, time(0), tzinfo=tz).astimezone(UTC)
