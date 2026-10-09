"""SQLite access. One connection per database file, used under a lock from worker threads.

Two files live in the data directory:
- app.db: settings revisions, prices, forecasts, problems. Included in Home Assistant backups.
- runs.db: run records, artifacts and logs. Bulky and pruned by retention; excluded from backups.
"""

import asyncio
import logging
import sqlite3
import threading
from collections.abc import Callable, Iterable, Mapping, Sequence
from importlib import resources
from pathlib import Path
from typing import Any

log = logging.getLogger("emhass_lens.db")

Params = Sequence[Any] | Mapping[str, Any]


class Database:
    def __init__(self, path: Path | str, name: str) -> None:
        self.path = str(path)
        self.name = name  # migrations folder: db/sql/<name>/
        self._conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            if self.path != ":memory:":
                self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.execute("PRAGMA busy_timeout=5000")
            self._conn.execute("PRAGMA foreign_keys=ON")

    # --- synchronous API, for worker threads -------------------------------------------------
    def execute(self, sql: str, params: Params = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._conn.execute(sql, params)

    def executemany(self, sql: str, rows: Iterable[Params]) -> None:
        with self._lock:
            self._conn.execute("BEGIN")
            try:
                self._conn.executemany(sql, rows)
                self._conn.execute("COMMIT")
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise

    def query(self, sql: str, params: Params = ()) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(row) for row in self._conn.execute(sql, params).fetchall()]

    def query_one(self, sql: str, params: Params = ()) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(sql, params).fetchone()
            return dict(row) if row else None

    def transaction[T](self, fn: Callable[[sqlite3.Connection], T]) -> T:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                result = fn(self._conn)
                self._conn.execute("COMMIT")
                return result
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise

    # --- async API, for the event loop ---------------------------------------------------------
    async def run[T](self, fn: Callable[..., T], *args: Any) -> T:
        return await asyncio.to_thread(fn, *args)

    async def aquery(self, sql: str, params: Params = ()) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self.query, sql, params)

    async def aquery_one(self, sql: str, params: Params = ()) -> dict[str, Any] | None:
        return await asyncio.to_thread(self.query_one, sql, params)

    async def aexecute(self, sql: str, params: Params = ()) -> int | None:
        def go() -> int | None:
            return self.execute(sql, params).lastrowid

        return await asyncio.to_thread(go)

    # --- schema ----------------------------------------------------------------------------------
    def migrate(self) -> int:
        """Apply the numbered .sql files in db/sql/<name>/ that are newer than PRAGMA user_version."""
        folder = resources.files("emhass_lens.db").joinpath("sql", self.name)
        scripts = sorted(
            (int(entry.name.split("_", 1)[0]), entry) for entry in folder.iterdir() if entry.name.endswith(".sql")
        )
        with self._lock:
            current = self._conn.execute("PRAGMA user_version").fetchone()[0]
            for number, entry in scripts:
                if number <= current:
                    continue
                sql = entry.read_text(encoding="utf-8")
                log.info("Migrating %s to version %d (%s)", self.name, number, entry.name)
                self._conn.executescript(f"BEGIN;\n{sql}\nPRAGMA user_version = {number};\nCOMMIT;")
                current = number
        return current

    def checkpoint(self) -> None:
        with self._lock:
            self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def size_bytes(self) -> int:
        total = 0
        for suffix in ("", "-wal", "-shm"):
            path = Path(self.path + suffix)
            if path.exists():
                total += path.stat().st_size
        return total

    def close(self) -> None:
        with self._lock:
            self._conn.close()
