"""Storage: what the two databases hold, day-based retention, size budgets, compaction, and what the
Health page's Storage card shows.

Cleanup runs daily (job maintenance.retention) and on demand: first the day-based rules (Settings → Storage →
Retention), then each database is held within its size budget by cutting the oldest calendar day of one table
at a time in a fixed order, and finally the write-ahead logs are checkpointed and a file with enough free
pages is compacted with VACUUM. Every step runs in a worker thread and holds the database lock only for one
statement, so the UI and the log sink wait milliseconds, not minutes.
"""

import json
import logging
import shutil
import time
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import TYPE_CHECKING, Any

from emhass_lens.clients.supervisor import SupervisorError
from emhass_lens.core.clock import iso, parse_iso
from emhass_lens.db.conn import Database, PageStats
from emhass_lens.scheduler.core import JobContext

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.storage")

MIB = 1024 * 1024
MIN_FREE_BYTES = 16 * MIB  # compact only when at least this much ...
MIN_FREE_SHARE = 0.20  # ... and this share of the file is free pages
MAX_TRIM_STEPS = 500  # budget steps (one day of one table each) per cleanup
DISK_LOW_BYTES = 200 * MIB
REVISIONS_FLOOR = 20  # the budget pass never cuts settings history below this
REVISIONS_AGE = timedelta(days=30)
LAST_CLEANUP_KEY = "storage.last_cleanup"
LAST_COMPACT_KEY = "storage.last_compact"
RESTORE_KEY = "restore.detected"
BACKUP_MARKER = "backup-marker.json"  # written by backup_pre inside /data, so it travels with the backup
BACKUP_CACHE_S = 600
# app.db columns that point at run numbers in runs.db
RUN_REFERENCES = (
    ("plan_snapshot", "run_id"),
    ("market_session", "start_run_id"),
    ("market_session", "end_run_id"),
    ("sofar_commit", "run_id"),
    ("costfun_result", "run_id"),
)
TABLES_CACHE_S = 300
NOT_PINNED = "run_id NOT IN (SELECT id FROM run WHERE pinned = 1)"


@dataclass(frozen=True)
class TableSpec:
    """A table the budget pass may cut, oldest calendar day first, never newer than `floor_days` ago."""

    db: str  # app | runs
    table: str
    ts_col: str  # ISO UTC text, or a date (YYYY-MM-DD) when date_only
    floor_days: int
    date_only: bool = False
    where: str = "1=1"
    label: str = ""  # for the summary; the table name when empty


RUNS_LADDER: tuple[TableSpec, ...] = (
    TableSpec("runs", "log", "ts", 1, where=f"(run_id IS NULL OR {NOT_PINNED})", label="log lines"),
    TableSpec("runs", "run_artifact", "created_at", 1, where=NOT_PINNED, label="run details"),
    TableSpec("runs", "run", "started_at", 2, where="pinned = 0", label="runs"),
)
APP_LADDER: tuple[TableSpec, ...] = (
    TableSpec("app", "costfun_result", "compared_at", 2, label="cost-function plans"),
    TableSpec("app", "plan_snapshot", "fetched_at", 2, label="plans"),
    TableSpec("app", "measurement", "slot_utc", 7, label="measurements"),
    TableSpec("app", "forecast_snapshot", "fetched_at", 2, label="forecast snapshots"),
    TableSpec("app", "price_slot", "day", 3, date_only=True, label="price slots"),
    TableSpec("app", "price_day", "day", 3, date_only=True, label="price days"),
    TableSpec("app", "sofar_press", "at", 2, label="inverter button presses"),
    TableSpec("app", "sofar_commit", "at", 2, label="inverter writes"),
    TableSpec("app", "problem_event", "ended_at", 2, where="ended_at IS NOT NULL", label="problem records"),
    TableSpec("app", "market_session", "ended_at", 7, where="ended_at IS NOT NULL", label="market sessions"),
)
# the column that says how old a table's oldest row is (for the overview)
AGE_COLUMNS: dict[str, tuple[str, bool]] = {
    **{spec.table: (spec.ts_col, spec.date_only) for spec in RUNS_LADDER + APP_LADDER},
    "settings_revision": ("created_at", False),
    "plan_row": ("slot_utc", False),
    "forecast_point": ("start_utc", False),
}
BACKED_UP = {"app.db": True, "runs.db": False}


def should_vacuum(stats: PageStats, *, min_free: int = MIN_FREE_BYTES, min_share: float = MIN_FREE_SHARE) -> bool:
    """Worth a VACUUM: enough free pages to matter, in bytes and as a share of the file."""
    if stats.page_count <= 0:
        return False
    return stats.free_bytes >= min_free and stats.freelist_count / stats.page_count >= min_share


def next_day_after(value: str, date_only: bool) -> str:
    """The start of the UTC day after the one `value` falls in, in the column's own format."""
    if date_only:
        return (date.fromisoformat(value[:10]) + timedelta(days=1)).isoformat()
    stamp = parse_iso(value)
    if stamp is None:
        return value
    start = stamp.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    return iso(start + timedelta(days=1)) or value


def cut_for(spec: TableSpec, moment: datetime) -> str:
    return moment.astimezone(UTC).date().isoformat() if spec.date_only else (iso(moment) or "")


class StorageService:
    def __init__(self, c: Container) -> None:
        self.c = c
        self.last_cleanup: dict[str, Any] | None = c.kv_get(LAST_CLEANUP_KEY)
        self.last_compact: dict[str, Any] | None = c.kv_get(LAST_COMPACT_KEY)
        self.last_backup: dict[str, Any] | None = None
        self._backup_checked: float | None = None
        self._self_slug: str | None = None
        self._tables_cache: dict[str, tuple[float, dict[str, int]]] = {}

    # --- facts -----------------------------------------------------------------------------------------
    def _db(self, name: str) -> Database:
        return self.c.app_db if name == "app.db" else self.c.runs_db

    def budget_bytes(self, name: str) -> int:
        storage = self.c.settings.current.storage
        return (storage.app_db_max_mb if name == "app.db" else storage.runs_db_max_mb) * MIB

    def disk(self) -> tuple[int, int]:
        usage = shutil.disk_usage(self.c.boot.data_dir)
        return usage.free, usage.total

    def over_budget(self) -> list[str]:
        """Databases whose data is still over budget after the last cleanup."""
        return list((self.last_cleanup or {}).get("over_budget") or [])

    def disk_low_bytes(self) -> int:
        return DISK_LOW_BYTES

    # --- restored from a backup? -------------------------------------------------------------------------
    def detect_restore(self) -> dict[str, Any] | None:
        """At start: runs.db is excluded from backups, so after a restore it is empty while app.db still
        points at run numbers. Insert one pinned placeholder run with the highest referenced number, so new
        runs number after it and the old references don't land on unrelated runs. Returns the restore record
        (new or remembered)."""
        c = self.c
        if c.runs_db.query_one("SELECT 1 AS one FROM run LIMIT 1") is not None:
            return self.restored()
        highest = 0
        for table, column in RUN_REFERENCES:
            row = c.app_db.query_one(f"SELECT max({column}) AS n FROM {table}")
            if row and row["n"]:
                highest = max(highest, int(row["n"]))
        if highest <= 0:
            return None  # a fresh install
        now = c.clock.now()
        marker = self._read_marker()
        c.runs_db.execute(
            "INSERT INTO run (id, job, trigger, started_at, finished_at, duration_ms, outcome, summary, settings_rev, "
            "pinned) VALUES (?,?,?,?,?,0,?,?,?,1)",
            (
                highest,
                "system.restore",
                "manual",
                iso(now),
                iso(now),
                "noop",
                f"Run history up to #{highest} was not part of the backup; numbering continues after it",
                c.settings.revision,
            ),
        )
        record = {
            "detected_at": iso(now),
            "last_run_id": highest,
            "backup_taken_at": marker.get("at") if marker else None,
            "acknowledged": False,
        }
        c.kv_set(RESTORE_KEY, record)
        log.info(
            "Restored from a backup%s: run history up to #%d is gone, numbering continues after it",
            f" taken {marker.get('at')}" if marker and marker.get("at") else "",
            highest,
        )
        return record

    def _read_marker(self) -> dict[str, Any] | None:
        path = self.c.boot.data_dir / BACKUP_MARKER
        try:
            data = json.loads(path.read_text())
        except OSError, ValueError:
            return None
        return data if isinstance(data, dict) else None

    def restored(self) -> dict[str, Any] | None:
        record = self.c.kv_get(RESTORE_KEY)
        return record if isinstance(record, dict) else None

    def acknowledge_restore(self) -> None:
        record = self.restored()
        if record is not None:
            record["acknowledged"] = True
            self.c.kv_set(RESTORE_KEY, record)

    # --- the newest Home Assistant backup that contains the App -------------------------------------------
    async def backup_status(self, *, refresh: bool = False) -> dict[str, Any]:
        """Asks the Supervisor (needs the `backup` role); cached for ten minutes."""
        fresh = self._backup_checked is not None and time.monotonic() - self._backup_checked < BACKUP_CACHE_S
        if self.last_backup is not None and not refresh and fresh:
            return self.last_backup
        supervisor = self.c.extras.get("supervisor")
        result: dict[str, Any] = {
            "available": False,
            "reason": None,
            "newest_at": None,
            "newest_name": None,
            "newest_type": None,
            "newest_size_mb": None,
            "count": 0,
            "stale": False,
        }
        if supervisor is None or not supervisor.available:
            result["reason"] = "not running as a Home Assistant App"
        else:
            try:
                if self._self_slug is None:
                    self._self_slug = str((await supervisor.self_info()).get("slug") or "")
                backups = await supervisor.backups()
            except SupervisorError as exc:
                result["reason"] = f"the Supervisor refused to list backups ({exc})"
            else:
                slug = self._self_slug
                ours = [b for b in backups if slug and slug in ((b.get("content") or {}).get("addons") or [])]
                result["available"] = True
                result["count"] = len(ours)
                newest = max(ours, key=lambda b: str(b.get("date") or ""), default=None)
                warn_days = self.c.settings.current.storage.backup_warn_days
                if newest is not None:
                    result["newest_at"] = newest.get("date")
                    result["newest_name"] = newest.get("name")
                    result["newest_type"] = newest.get("type")
                    size = newest.get("size")
                    result["newest_size_mb"] = float(size) if isinstance(size, (int, float)) else None
                    when = parse_iso(str(newest.get("date"))) if newest.get("date") else None
                    too_old = when is None or self.c.clock.now() - when > timedelta(days=warn_days)
                    result["stale"] = bool(warn_days) and too_old
                else:
                    result["stale"] = bool(warn_days)
        self.last_backup = result
        self._backup_checked = time.monotonic()
        return result

    # --- cleanup ---------------------------------------------------------------------------------------
    async def cleanup(self, ctx: JobContext | None, *, trigger: str) -> dict[str, Any]:
        """Day-based retention, size budgets, checkpoints, and compaction when worthwhile."""
        c = self.c
        now = c.clock.now()
        t0 = time.monotonic()
        removed: dict[str, int] = {}
        removed |= await c.runs_db.run(self._prune_runs_db, now)
        removed |= await c.app_db.run(self._prune_app_db, now)
        trimmed = {
            "runs.db": await c.runs_db.run(self._enforce_budget, "runs.db", RUNS_LADDER, now),
            "app.db": await c.app_db.run(self._enforce_budget, "app.db", APP_LADDER, now),
        }
        await c.runs_db.run(c.runs_db.checkpoint)
        await c.app_db.run(c.app_db.checkpoint)
        over = [
            name for name in ("runs.db", "app.db") if self._db(name).page_stats().data_bytes > self.budget_bytes(name)
        ]
        vacuum: dict[str, dict[str, Any]] = {}
        if c.settings.current.storage.compact == "auto":
            for name in ("runs.db", "app.db"):
                vacuum[name] = await self._db(name).run(self._maybe_vacuum, name, False)
        result = {
            "at": iso(now),
            "trigger": trigger,
            "duration_ms": int((time.monotonic() - t0) * 1000),
            "removed": removed,
            "trimmed": trimmed,
            "vacuum": vacuum,
            "over_budget": over,
            "summary": "",
        }
        result["summary"] = self.describe(result)
        self.last_cleanup = result
        await c.app_db.run(c.kv_set, LAST_CLEANUP_KEY, result)
        if any(v.get("ran") for v in vacuum.values()):
            self.last_compact = {"at": iso(now), "databases": vacuum}
            await c.app_db.run(c.kv_set, LAST_COMPACT_KEY, self.last_compact)
        self._tables_cache.clear()
        log.info(result["summary"])
        if ctx is not None and ctx.run:
            ctx.run.summary = result["summary"]
        return result

    async def compact(self, ctx: JobContext | None) -> dict[str, Any]:
        """Compact now: VACUUM both files whatever the thresholds say (the disk check still applies)."""
        c = self.c
        now = c.clock.now()
        for name in ("runs.db", "app.db"):
            await self._db(name).run(self._db(name).checkpoint)
        results = {name: await self._db(name).run(self._maybe_vacuum, name, True) for name in ("runs.db", "app.db")}
        self.last_compact = {"at": iso(now), "databases": results}
        await c.app_db.run(c.kv_set, LAST_COMPACT_KEY, self.last_compact)
        self._tables_cache.clear()
        parts = []
        for name, r in results.items():
            if r.get("ran"):
                parts.append(
                    f"{name} {(r['before_bytes'] or 0) / MIB:.0f} → {(r['after_bytes'] or 0) / MIB:.0f} MiB "
                    f"in {(r['duration_ms'] or 0) / 1000:.1f} s"
                )
            else:
                parts.append(f"{name} not compacted: {r.get('reason')}")
        summary = "Compacted " + "; ".join(parts)
        if ctx is not None and ctx.run:
            ctx.run.summary = summary
        log.info(summary)
        return results

    # --- day-based retention (worker thread) ---------------------------------------------------------------
    def _prune_runs_db(self, now: datetime) -> dict[str, int]:
        keep = self.c.settings.current.storage.retention
        db = self.c.runs_db
        out: dict[str, int] = {}
        for spec, days in (
            (RUNS_LADDER[0], keep.logs_days),
            (RUNS_LADDER[1], keep.artifacts_days),
            (RUNS_LADDER[2], keep.runs_days),
        ):
            cut = cut_for(spec, now - timedelta(days=days))
            out[spec.table] = self._trim_before(db, spec, cut)
        return out

    def _prune_app_db(self, now: datetime) -> dict[str, int]:
        keep = self.c.settings.current.storage.retention
        x = self.c.extras
        db = self.c.app_db
        out: dict[str, int] = {}
        if "prices" in x:
            out["price_slot"] = x["prices"].prune(now)
            out["forecast_snapshot"] = x["forecasts"].prune(now)
            out["plan_snapshot"] = x["emhass"].prune(2000, now)
        if "measurements" in x:
            out["measurement"] = x["measurements"].prune(now)
        if "costfun" in x:
            out["costfun_result"] = x["costfun"].prune(now)
        if "sofar" in x:
            out["sofar_commit"] = x["sofar"].prune(now)
        out["problem_event"] = db.execute(
            "DELETE FROM problem_event WHERE ended_at IS NOT NULL AND ended_at < ?",
            (iso(now - timedelta(days=keep.problems_days)),),
        ).rowcount
        out["market_session"] = db.execute(
            "DELETE FROM market_session WHERE ended_at IS NOT NULL AND ended_at < ?",
            (iso(now - timedelta(days=keep.sessions_days)),),
        ).rowcount
        out["settings_revision"] = self._trim_revisions(keep.settings_revisions, now - REVISIONS_AGE)
        return out

    def _trim_revisions(self, keep: int, older_than: datetime | None) -> int:
        """Settings history: never the current revision, never the newest `keep`, and (when given) only rows
        older than `older_than`."""
        params: list[Any] = [self.c.settings.revision, keep]
        age = ""
        if older_than is not None:
            age = "AND created_at < ?"
            params.append(iso(older_than))
        return self.c.app_db.execute(
            "DELETE FROM settings_revision WHERE id != ? "
            f"AND id NOT IN (SELECT id FROM settings_revision ORDER BY id DESC LIMIT ?) {age}",
            params,
        ).rowcount

    # --- the primitive and the budget pass (worker thread) ------------------------------------------------
    def _trim_oldest_day(self, db: Database, spec: TableSpec, not_after: str) -> int:
        """Delete the oldest calendar day of the table, but nothing at or after `not_after`. 0 = nothing left."""
        row = db.query_one(f"SELECT min({spec.ts_col}) AS t FROM {spec.table} WHERE {spec.where}")
        oldest = row["t"] if row else None
        if not oldest:
            return 0
        cut = min(next_day_after(str(oldest), spec.date_only), not_after)
        if cut <= str(oldest):
            return 0
        return db.execute(f"DELETE FROM {spec.table} WHERE {spec.ts_col} < ? AND {spec.where}", (cut,)).rowcount

    def _trim_before(self, db: Database, spec: TableSpec, cut: str) -> int:
        """Day-based retention in day-sized steps, so a big backlog never holds the lock for long."""
        total = 0
        for _ in range(MAX_TRIM_STEPS):
            n = self._trim_oldest_day(db, spec, cut)
            if n == 0:
                break
            total += n
        return total

    def _enforce_budget(self, name: str, ladder: tuple[TableSpec, ...], now: datetime) -> dict[str, int]:
        db = self._db(name)
        budget = self.budget_bytes(name)
        trimmed: dict[str, int] = {}
        steps = 0
        for spec in ladder:
            if db.page_stats().data_bytes <= budget:
                return trimmed
            not_after = cut_for(spec, now - timedelta(days=spec.floor_days))
            while steps < MAX_TRIM_STEPS and db.page_stats().data_bytes > budget:
                n = self._trim_oldest_day(db, spec, not_after)
                if n == 0:
                    break
                trimmed[spec.table] = trimmed.get(spec.table, 0) + n
                steps += 1
        if name == "app.db" and db.page_stats().data_bytes > budget:
            n = self._trim_revisions(REVISIONS_FLOOR, None)
            if n:
                trimmed["settings_revision"] = n
        return trimmed

    def _maybe_vacuum(self, name: str, force: bool) -> dict[str, Any]:
        db = self._db(name)
        stats = db.page_stats()
        before = db.size_parts()["db"]
        result: dict[str, Any] = {
            "ran": False,
            "reason": None,
            "duration_ms": None,
            "before_bytes": before,
            "after_bytes": None,
        }
        if not force and not should_vacuum(stats):
            result["reason"] = (
                f"only {stats.free_bytes // MIB} MiB free pages "
                f"({100 * stats.freelist_count / max(1, stats.page_count):.0f} %)"
            )
            return result
        free, _total = self.disk()
        needed = 2 * stats.file_bytes + 64 * MIB
        if free < needed:
            result["reason"] = f"disk has {free // MIB} MiB free, VACUUM needs about {needed // MIB} MiB"
            return result
        t0 = time.monotonic()
        db.vacuum()
        result["ran"] = True
        result["duration_ms"] = int((time.monotonic() - t0) * 1000)
        result["after_bytes"] = db.size_parts()["db"]
        return result

    # --- words ---------------------------------------------------------------------------------------------
    def describe(self, result: dict[str, Any]) -> str:
        labels = {spec.table: spec.label or spec.table for spec in RUNS_LADDER + APP_LADDER}
        labels["settings_revision"] = "settings versions"
        removed = result.get("removed") or {}
        parts = [f"{n:,} {labels.get(t, t)}".replace(",", " ") for t, n in removed.items() if n]
        text = ("Removed " + ", ".join(parts)) if parts else "Nothing old to remove"
        budget_parts = []
        for name, cuts in (result.get("trimmed") or {}).items():
            for table, n in cuts.items():
                budget_parts.append(f"{name}: {n:,} {labels.get(table, table)}".replace(",", " "))
        if budget_parts:
            text += "; over budget, cut " + ", ".join(budget_parts)
        over = result.get("over_budget") or []
        if over:
            text += f"; still over budget: {', '.join(over)}"
        for name, v in (result.get("vacuum") or {}).items():
            if v.get("ran"):
                text += (
                    f"; compacted {name} {(v['before_bytes'] or 0) / MIB:.0f} → "
                    f"{(v['after_bytes'] or 0) / MIB:.0f} MiB in {(v['duration_ms'] or 0) / 1000:.1f} s"
                )
        return text

    # --- the overview (worker thread) ---------------------------------------------------------------------
    def _table_bytes(self, name: str) -> dict[str, int]:
        cached = self._tables_cache.get(name)
        if cached and time.monotonic() - cached[0] < TABLES_CACHE_S:
            return cached[1]
        sizes = self._db(name).table_bytes()
        self._tables_cache[name] = (time.monotonic(), sizes)
        return sizes

    def overview(self) -> dict[str, Any]:
        now = self.c.clock.now()
        free, total = self.disk()
        databases = []
        dbstat = True
        for name in ("app.db", "runs.db"):
            db = self._db(name)
            stats = db.page_stats()
            parts = db.size_parts()
            sizes = self._table_bytes(name)
            dbstat = dbstat and db.dbstat_available()
            tables = []
            for table in db.table_names():
                count = db.query_one(f"SELECT count(*) AS n FROM {table}")
                oldest = None
                age = AGE_COLUMNS.get(table)
                if age is not None:
                    row = db.query_one(f"SELECT min({age[0]}) AS t FROM {table}")
                    oldest = str(row["t"]) if row and row["t"] else None
                tables.append(
                    {
                        "name": table,
                        "rows": int(count["n"]) if count else 0,
                        "bytes": sizes.get(table),
                        "oldest": oldest,
                    }
                )
            tables.sort(key=lambda t: -(t["bytes"] or 0))
            budget = self.budget_bytes(name)
            databases.append(
                {
                    "name": name,
                    "backed_up": BACKED_UP[name],
                    "file_bytes": parts["db"],
                    "wal_bytes": parts["wal"],
                    "page_size": stats.page_size,
                    "page_count": stats.page_count,
                    "freelist_pages": stats.freelist_count,
                    "data_bytes": stats.data_bytes,
                    "free_bytes": stats.free_bytes,
                    "budget_bytes": budget,
                    "over_budget": stats.data_bytes > budget,
                    "tables": tables,
                }
            )
        return {
            "data_dir": str(self.c.boot.data_dir),
            "disk_free_bytes": free,
            "disk_total_bytes": total,
            "measured_at": iso(now),
            "dbstat": dbstat,
            "databases": databases,
            "last_cleanup": self.last_cleanup,
            "last_compact": self.last_compact,
        }
