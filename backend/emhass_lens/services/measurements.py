"""What actually happened: quarter-hour means of grid, battery, PV, house load and SOC, read from the
Home Assistant recorder and kept in app.db so the Plan page can draw history and judge the plan.

Two jobs: `measure.sample` reads the slot that just ended, every quarter-hour; `measure.backfill`
reads older history in chunks (newest first) after a start or a settings change until the recorder's
reach (Settings → Measurements → Read history back) is covered. What has been fetched is remembered as
one contiguous range, so slots the recorder has no data for are not asked for again and again.
"""

import logging
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from emhass_lens.core.clock import iso, parse_iso
from emhass_lens.core.slots import SLOT, slot_floor
from emhass_lens.domain.measure import slot_means
from emhass_lens.scheduler.core import JobContext
from emhass_lens.settings.model import MeasuredPower

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.measurements")

QUANTITIES = ("grid", "batt", "pv", "load", "soc")
FIELDS = {"grid": "grid", "batt": "battery", "pv": "pv", "load": "load", "soc": "soc"}
CHUNK_SLOTS = 24  # six hours per recorder request; chatty power sensors make bigger answers heavy
COVERED_KEY = "measure.covered"


class MeasurementService:
    def __init__(self, c: Container) -> None:
        self.c = c
        self.backfill_wanted = True
        self.last_sample_at: datetime | None = None
        self.last_error: str | None = None
        self.backfill_remaining = 0
        self._start_over = False
        self.consecutive_errors = 0
        self.retry_at: datetime | None = None

    # --- configuration -----------------------------------------------------------------------------
    def configured(self) -> dict[str, MeasuredPower]:
        m = self.c.settings.current.measurements
        out: dict[str, MeasuredPower] = {}
        for quantity in QUANTITIES:
            cfg: MeasuredPower = getattr(m, FIELDS[quantity])
            if cfg.entity:
                out[quantity] = cfg
        return out

    def entities(self) -> set[str]:
        return {cfg.entity for cfg in self.configured().values()}

    def enabled(self) -> bool:
        return bool(self.configured())

    def on_settings(self, *_: Any) -> None:
        """Entities, scales or signs changed: read everything again."""
        self._start_over = True
        self.backfill_wanted = True
        self.c.scheduler.retime("measure.backfill")

    # --- the covered range -----------------------------------------------------------------------
    def _covered(self) -> tuple[datetime, datetime] | None:
        saved = self.c.kv_get(COVERED_KEY)
        if not saved or saved.get("entities") != sorted(self.entities()):
            return None
        a, b = parse_iso(saved.get("from")), parse_iso(saved.get("to"))
        return (a, b) if a is not None and b is not None and a < b else None

    def _set_covered(self, start: datetime, end: datetime) -> None:
        self.c.kv_set(COVERED_KEY, {"from": iso(start), "to": iso(end), "entities": sorted(self.entities())})

    def _extend_covered(self, start: datetime, end: datetime) -> None:
        covered = self._covered()
        if covered is None or end < covered[0] or start > covered[1]:  # nothing yet, or not contiguous: restart
            self._set_covered(start, end)
        else:
            self._set_covered(min(start, covered[0]), max(end, covered[1]))

    # --- jobs ----------------------------------------------------------------------------------------------
    async def sample(self, ctx: JobContext) -> None:
        """The slot that just ended."""
        configured = self.configured()
        if not configured:
            if ctx.run:
                ctx.run.outcome, ctx.run.summary = (
                    "noop",
                    "No measurement entities configured (Settings → Measurements)",
                )
            return
        end = slot_floor(self.c.clock.now())
        start = end - SLOT
        covered = await self.c.app_db.run(self._covered)
        try:
            counts = await self._fetch_store(start, end, configured)
        except Exception as exc:
            if ctx.run:
                ctx.run.outcome, ctx.run.error = "error", str(exc)
            return
        await self.c.app_db.run(self._extend_covered, start, end)
        if covered is None or covered[1] < start:  # a gap since the last fetch (restart, HA down): fill it
            self.backfill_wanted = True
            self.c.scheduler.retime("measure.backfill")
        if ctx.run:
            got = sum(1 for n in counts.values() if n)
            ctx.run.artifact("sample", {"slot": iso(start), "quantities": counts})
            ctx.run.summary = (
                f"Slot {start.astimezone(self.c.extras['prices'].tz):%H:%M}: {got} of {len(configured)} quantities"
            )
            if got < len(configured):
                missing = ", ".join(q for q, n in counts.items() if not n)
                ctx.run.summary += f" (no data for {missing})"

    def next_backfill(self, after: datetime) -> datetime | None:
        if not self.backfill_wanted or not self.configured():
            return None
        if self.retry_at is not None and self.retry_at > after:
            return self.retry_at
        return after + timedelta(seconds=5)

    def _todo(self, now: datetime) -> tuple[list[tuple[datetime, datetime]], int]:
        """The ranges still to read ([newest gap], [oldest gap]) and the number of slots they hold."""
        end = slot_floor(now)
        horizon = end - timedelta(days=self.c.settings.current.measurements.backfill_days)
        covered = self._covered()
        if covered is None:
            return [(horizon, end)], int((end - horizon) / SLOT)
        gaps: list[tuple[datetime, datetime]] = []
        if covered[1] < end:
            gaps.append((covered[1], end))
        if covered[0] > horizon:
            gaps.append((horizon, covered[0]))
        return gaps, sum(int((b - a) / SLOT) for a, b in gaps)

    async def backfill(self, ctx: JobContext) -> None:
        """One chunk of older history (newest gap first); re-arms itself until the range is covered."""
        configured = self.configured()
        if not configured:
            self.backfill_wanted = False
            if ctx.run:
                ctx.run.outcome, ctx.run.summary = "noop", "No measurement entities configured"
            return
        now = self.c.clock.now()
        if self._start_over:
            await self.c.app_db.run(self.c.kv_set, COVERED_KEY, None)
            self._start_over = False
        gaps, remaining = await self.c.app_db.run(self._todo, now)
        self.backfill_remaining = remaining
        if not gaps:
            self.backfill_wanted = False
            self.c.scheduler.retime("measure.backfill")
            if ctx.run:
                ctx.run.outcome, ctx.run.summary = "noop", "History is complete"
            return
        gap_start, gap_end = gaps[0]
        start = max(gap_start, gap_end - CHUNK_SLOTS * SLOT)
        try:
            counts = await self._fetch_store(start, gap_end, configured)
        except Exception as exc:
            # a failing recorder read backs off (5 min, 10, 20, … up to an hour) instead of hammering HA
            self.consecutive_errors += 1
            delay = min(300 * 2 ** (self.consecutive_errors - 1), 3600)
            self.retry_at = now + timedelta(seconds=delay)
            self.c.scheduler.retime("measure.backfill")
            if ctx.run:
                ctx.run.outcome, ctx.run.error = "error", f"{exc} (next try in {delay // 60} min)"
            return
        self.consecutive_errors = 0
        self.retry_at = None
        await self.c.app_db.run(self._extend_covered, start, gap_end)
        _, remaining = await self.c.app_db.run(self._todo, now)
        self.backfill_remaining = remaining
        self.backfill_wanted = remaining > 0
        self.c.scheduler.retime("measure.backfill")
        if ctx.run:
            tz = self.c.extras["prices"].tz
            ctx.run.artifact(
                "backfill", {"from": iso(start), "to": iso(gap_end), "quantities": counts, "remaining_slots": remaining}
            )
            slots = int((gap_end - start) / SLOT)
            ctx.run.summary = (
                f"Read {start.astimezone(tz):%a %H:%M} → {gap_end.astimezone(tz):%a %H:%M} ({slots} slots); "
                f"{remaining} slots to go"
                if remaining
                else f"Read {start.astimezone(tz):%a %H:%M} → "
                f"{gap_end.astimezone(tz):%a %H:%M} ({slots} slots); history is complete"
            )

    async def _fetch_store(
        self, start: datetime, end: datetime, configured: dict[str, MeasuredPower]
    ) -> dict[str, int]:
        """Read [start, end) from the recorder and store the slot means. Returns stored slots per quantity."""
        ids = sorted({cfg.entity for cfg in configured.values()})
        try:
            lists = await self.c.extras["ha"].history(start, end, ids)
        except Exception as exc:
            self.last_error = str(exc)
            raise
        by_entity: dict[str, list[dict[str, Any]]] = {}
        for lst in lists:
            first = lst[0] if lst else None
            if isinstance(first, dict) and first.get("entity_id"):
                by_entity[str(first["entity_id"])] = lst
        rows: list[tuple[Any, ...]] = []
        counts = dict.fromkeys(configured, 0)
        for quantity, cfg in configured.items():
            for m in slot_means(by_entity.get(cfg.entity, []), start, end):
                if m.value is None:
                    continue
                value = m.value * cfg.scale * (-1.0 if cfg.invert else 1.0)
                rows.append((iso(m.start), quantity, value, m.coverage, cfg.entity))
                counts[quantity] += 1
        if rows:
            await self.c.app_db.run(
                self.c.app_db.executemany,
                "INSERT OR REPLACE INTO measurement (slot_utc, quantity, value, coverage, entity_id) "
                "VALUES (?,?,?,?,?)",
                rows,
            )
        self.last_sample_at = self.c.clock.now()
        self.last_error = None
        return counts

    # --- reading --------------------------------------------------------------------------------------------
    def read(self, start: datetime, end: datetime) -> dict[str, dict[str, tuple[float, float]]]:
        """{quantity: {slot_utc: (value, coverage)}} for [start, end). Worker thread."""
        rows = self.c.app_db.query(
            "SELECT slot_utc, quantity, value, coverage FROM measurement WHERE slot_utc >= ? AND slot_utc < ?",
            (iso(start), iso(end)),
        )
        out: dict[str, dict[str, tuple[float, float]]] = {q: {} for q in QUANTITIES}
        for r in rows:
            out.setdefault(r["quantity"], {})[r["slot_utc"]] = (float(r["value"]), float(r["coverage"]))
        return out

    def status(self) -> dict[str, Any]:
        """Worker thread."""
        latest = {
            r["quantity"]: r
            for r in self.c.app_db.query(
                "SELECT quantity, slot_utc, value FROM measurement m WHERE slot_utc = "
                "(SELECT max(slot_utc) FROM measurement WHERE quantity = m.quantity)"
            )
        }
        configured = [
            {
                "quantity": q,
                "entity_id": cfg.entity,
                "last_slot": latest[q]["slot_utc"] if q in latest else None,
                "last_value": latest[q]["value"] if q in latest else None,
            }
            for q, cfg in self.configured().items()
        ]
        return {
            "configured": configured,
            "backfill_remaining_slots": self.backfill_remaining if self.backfill_wanted else 0,
            "last_sample_at": iso(self.last_sample_at),
            "last_error": self.last_error,
        }

    def prune(self, now: datetime) -> int:
        cut = iso(now - timedelta(days=self.c.settings.current.measurements.keep_days))
        return self.c.app_db.execute("DELETE FROM measurement WHERE slot_utc < ?", (cut,)).rowcount
