"""Logging setup: one pipeline feeding stdout (Supervisor Log tab), the UI ring and SQLite."""

import logging
import sys
from dataclasses import dataclass
from zoneinfo import ZoneInfo

from emhass_lens.core.bus import EventBus
from emhass_lens.db.conn import Database
from emhass_lens.logs.handlers import (
    ROOT,
    ContextFilter,
    LocalTimeFormatter,
    RedactFilter,
    RingHandler,
    SqliteLogHandler,
    reset_sequence,
)

LEVELS = ("debug", "info", "warning", "error")

# Third-party loggers that are noisy at INFO; access logs for polling/SSE add nothing.
_QUIET = {
    "uvicorn.access": logging.WARNING,
    "httpx": logging.WARNING,
    "httpcore": logging.WARNING,
    "websockets": logging.WARNING,
}


@dataclass
class LoggingHandles:
    ring: RingHandler
    stdout: logging.Handler
    sqlite: SqliteLogHandler | None = None
    base_level: int = logging.INFO

    def attach_sqlite(self, db: Database) -> None:
        """Start persisting log lines. Lines logged before this (startup, migrations) get fresh ids after
        the newest stored line and are written too, so the UI's history has them."""
        row = db.query_one("SELECT MAX(id) AS id FROM log")
        next_id = int((row or {}).get("id") or 0) + 1
        early = self.ring.renumber(next_id)
        if early:
            db.executemany(
                "INSERT OR IGNORE INTO log (id, ts, level, component, msg, run_id, job, exc) VALUES (?,?,?,?,?,?,?,?)",
                [
                    (e["id"], e["ts"], e["level"], e["component"], e["msg"], e["run_id"], e["job"], e["exc"])
                    for e in early
                ],
            )
        reset_sequence(next_id + len(early))
        handler = SqliteLogHandler(db)
        _prepare(handler)
        logging.getLogger().addHandler(handler)
        self.sqlite = handler

    def set_levels(self, level: str | None, components: dict[str, str] | None = None) -> None:
        """Apply levels live. level=None or "default" keeps the App option's level."""
        root_level = self.base_level if level in (None, "default") else _to_level(level)
        logging.getLogger(ROOT).setLevel(root_level)
        for name in list(logging.root.manager.loggerDict):
            if name.startswith(ROOT + "."):
                logging.getLogger(name).setLevel(logging.NOTSET)
        for component, comp_level in (components or {}).items():
            logging.getLogger(f"{ROOT}.{component}").setLevel(_to_level(comp_level))

    def close(self) -> None:
        root = logging.getLogger()
        for handler in (self.sqlite, self.ring, self.stdout):
            if handler is not None:
                root.removeHandler(handler)
                handler.close()


def _to_level(name: str) -> int:
    return logging.getLevelNamesMapping().get(name.upper(), logging.INFO)


def _prepare(handler: logging.Handler) -> None:
    handler.addFilter(ContextFilter())
    handler.addFilter(RedactFilter())


def setup_logging(bus: EventBus, level: str = "info", tz: str = "UTC") -> LoggingHandles:
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)
    # Third-party libraries never log below INFO (their DEBUG output dumps raw traffic, tokens included);
    # the emhass_lens logger has its own level, so the log_level option and component levels still apply.
    root.setLevel(logging.INFO)

    try:
        zone = ZoneInfo(tz)
    except Exception:
        zone = ZoneInfo("UTC")
    stdout = logging.StreamHandler(sys.stdout)
    stdout.setFormatter(LocalTimeFormatter(zone))
    _prepare(stdout)
    ring = RingHandler(bus)
    _prepare(ring)
    root.addHandler(stdout)
    root.addHandler(ring)

    base_level = _to_level(level)
    logging.getLogger(ROOT).setLevel(base_level)
    for name, quiet_level in _QUIET.items():
        logging.getLogger(name).setLevel(quiet_level)
    for name in ("uvicorn", "uvicorn.error"):
        logger = logging.getLogger(name)
        logger.handlers.clear()
        logger.propagate = True
        logger.setLevel(logging.INFO)
    return LoggingHandles(ring=ring, stdout=stdout, base_level=base_level)
