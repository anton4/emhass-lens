"""Everything the App is made of, wired explicitly once at startup and reachable from routes."""

import json
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from emhass_lens.bootstrap import Bootstrap
from emhass_lens.core.bus import EventBus
from emhass_lens.core.clock import Clock, iso
from emhass_lens.db.conn import Database
from emhass_lens.logs.setup import LoggingHandles
from emhass_lens.runs.recorder import RunRecorder
from emhass_lens.scheduler.core import Scheduler
from emhass_lens.settings.store import SettingsStore


@dataclass
class Container:
    boot: Bootstrap
    clock: Clock
    bus: EventBus
    logging: LoggingHandles
    app_db: Database
    runs_db: Database
    settings: SettingsStore
    recorder: RunRecorder
    scheduler: Scheduler
    started_at: datetime
    extras: dict[str, Any] = field(default_factory=dict)

    @property
    def started_at_iso(self) -> str:
        return iso(self.started_at) or ""

    # small persisted runtime state
    def kv_get(self, key: str, default: Any = None) -> Any:
        row = self.app_db.query_one("SELECT value_json FROM kv WHERE key = ?", (key,))
        return json.loads(row["value_json"]) if row else default

    def kv_set(self, key: str, value: Any) -> None:
        self.app_db.execute(
            "INSERT INTO kv (key, value_json, updated_at) VALUES (?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            (key, json.dumps(value), iso(self.clock.now())),
        )
