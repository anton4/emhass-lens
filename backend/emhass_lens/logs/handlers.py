"""Log handlers: the in-memory ring that feeds the UI live tail, and the SQLite sink for history.

Every record passes ContextFilter (adds run_id/job/component) and RedactFilter (masks secrets)
before it reaches a handler, so the stdout, UI and database copies are identical.
"""

import logging
import threading
import time
import traceback
from collections import deque
from datetime import UTC, datetime
from itertools import count
from typing import Any

from emhass_lens.core.bus import EventBus
from emhass_lens.core.redact import redactor
from emhass_lens.db.conn import Database
from emhass_lens.logs.context import job_var, run_id_var

ROOT = "emhass_lens"
_seq = count(1)


def reset_sequence(start: int) -> None:
    """Continue log ids after the newest stored line, so ring and database ids agree."""
    global _seq
    _seq = count(start)


def component_of(logger_name: str) -> str:
    if logger_name == ROOT:
        return "app"
    if logger_name.startswith(ROOT + "."):
        return logger_name[len(ROOT) + 1 :]
    return logger_name.split(".", 1)[0]  # uvicorn, httpx, ...


class ContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "run_id"):
            record.run_id = run_id_var.get()
        if not hasattr(record, "job"):
            record.job = job_var.get()
        record.component = component_of(record.name)
        return True


class RedactFilter(logging.Filter):
    """Formats the message once, masks secrets in it, and freezes the result on the record."""

    def filter(self, record: logging.LogRecord) -> bool:
        if getattr(record, "_redacted", False):
            return True
        try:
            message = record.getMessage()
        except Exception:  # bad format args: keep what we can
            message = f"{record.msg!r} {record.args!r}"
        record.msg = redactor.text(message)
        record.args = None
        if record.exc_info and not record.exc_text:
            record.exc_text = "".join(traceback.format_exception(*record.exc_info))
        if record.exc_text:
            record.exc_text = redactor.text(record.exc_text)
        record._redacted = True
        return True


def to_entry(record: logging.LogRecord) -> dict[str, Any]:
    return {
        "id": next(_seq),
        "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
        "level": record.levelname,
        "component": getattr(record, "component", component_of(record.name)),
        "msg": record.getMessage(),
        "run_id": getattr(record, "run_id", None),
        "job": getattr(record, "job", None),
        "exc": record.exc_text or None,
    }


class RingHandler(logging.Handler):
    """Keeps the newest log lines in memory and pushes each one to the event bus."""

    def __init__(self, bus: EventBus, capacity: int = 5000) -> None:
        super().__init__()
        self.bus = bus
        self.entries: deque[dict[str, Any]] = deque(maxlen=capacity)
        self._entry_lock = threading.Lock()

    def emit(self, record: logging.LogRecord) -> None:
        try:
            entry = to_entry(record)
            record.entry = entry  # reused by the SQLite sink so both share the same id
            with self._entry_lock:
                self.entries.append(entry)
            self.bus.publish("log", entry)
        except Exception:
            self.handleError(record)

    def renumber(self, start: int) -> list[dict[str, Any]]:
        """Give every line held so far consecutive ids from `start` (used once, at sink attach)."""
        with self._entry_lock:
            for offset, entry in enumerate(self.entries):
                entry["id"] = start + offset
            return list(self.entries)

    def tail(self, limit: int = 500) -> list[dict[str, Any]]:
        with self._entry_lock:
            items = list(self.entries)
        return items[-limit:]


class SqliteLogHandler(logging.Handler):
    """Batches log lines into runs.db from a background thread (one insert per second)."""

    def __init__(self, db: Database, flush_interval: float = 1.0) -> None:
        super().__init__()
        self.db = db
        self.flush_interval = flush_interval
        self._pending: list[tuple[Any, ...]] = []
        self._pending_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="log-sink", daemon=True)
        self._thread.start()

    def emit(self, record: logging.LogRecord) -> None:
        entry = getattr(record, "entry", None) or to_entry(record)
        row = (
            entry["id"],
            entry["ts"],
            entry["level"],
            entry["component"],
            entry["msg"],
            entry["run_id"],
            entry["job"],
            entry["exc"],
        )
        with self._pending_lock:
            self._pending.append(row)

    def _run(self) -> None:
        while not self._stop.wait(self.flush_interval):
            self.flush()

    def flush(self) -> None:
        with self._pending_lock:
            rows, self._pending = self._pending, []
        if not rows:
            return
        try:
            self.db.executemany(
                "INSERT OR IGNORE INTO log (id, ts, level, component, msg, run_id, job, exc) VALUES (?,?,?,?,?,?,?,?)",
                rows,
            )
        except Exception as exc:  # never let logging take the app down; report on stderr only
            print(f"log sink: dropped {len(rows)} lines: {exc}", flush=True)

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=2)
        self.flush()
        super().close()


class LocalTimeFormatter(logging.Formatter):
    """stdout format for the Supervisor Log tab: local time, level, component, run and message."""

    def __init__(self, tz: Any) -> None:
        super().__init__()
        self.tz = tz

    def format(self, record: logging.LogRecord) -> str:
        ts = datetime.fromtimestamp(record.created, self.tz).strftime("%Y-%m-%d %H:%M:%S")
        component = getattr(record, "component", component_of(record.name))
        run_id = getattr(record, "run_id", None)
        run = f" run={run_id}" if run_id else ""
        line = f"{ts} {record.levelname:<7} [{component}]{run} {record.getMessage()}"
        if record.exc_text:
            line += "\n" + record.exc_text.rstrip()
        return line


def monotonic_ms() -> int:
    return int(time.monotonic() * 1000)
