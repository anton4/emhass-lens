import asyncio
from datetime import UTC, datetime
from pathlib import Path

import pytest

from emhass_lens.core.bus import EventBus
from emhass_lens.core.clock import FakeClock
from emhass_lens.db.conn import Database
from emhass_lens.runs.recorder import RunRecorder
from emhass_lens.settings.store import SettingsStore


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock(datetime(2026, 10, 9, 11, 0, tzinfo=UTC))


@pytest.fixture
async def bus() -> EventBus:
    bus = EventBus()
    bus.bind(asyncio.get_running_loop())
    return bus


@pytest.fixture
def app_db(tmp_path: Path) -> Database:
    db = Database(tmp_path / "app.db", "app")
    db.migrate()
    return db


@pytest.fixture
def runs_db(tmp_path: Path) -> Database:
    db = Database(tmp_path / "runs.db", "runs")
    db.migrate()
    return db


@pytest.fixture
def recorder(runs_db: Database, bus: EventBus, clock: FakeClock) -> RunRecorder:
    return RunRecorder(runs_db, bus, clock)


@pytest.fixture
def store(app_db: Database, bus: EventBus, clock: FakeClock) -> SettingsStore:
    s = SettingsStore(db=app_db, bus=bus, clock=clock)
    s.load()
    return s
