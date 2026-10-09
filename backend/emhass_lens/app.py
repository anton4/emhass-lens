"""Builds the FastAPI app: wiring, startup/shutdown order, routes and the UI."""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from emhass_lens import system_jobs
from emhass_lens.api.routes import jobs, logs, meta, runs, settings
from emhass_lens.api.static import UIFiles
from emhass_lens.bootstrap import Bootstrap
from emhass_lens.container import Container
from emhass_lens.core.bus import EventBus
from emhass_lens.core.clock import Clock, SystemClock
from emhass_lens.db.conn import Database
from emhass_lens.logs.setup import LoggingHandles, setup_logging
from emhass_lens.runs.recorder import RunRecorder
from emhass_lens.scheduler.core import Scheduler
from emhass_lens.settings.model import Settings
from emhass_lens.settings.store import SettingsStore

log = logging.getLogger("emhass_lens")

PAUSED_JOBS_KEY = "scheduler.paused_jobs"


def build_container(boot: Bootstrap, bus: EventBus, handles: LoggingHandles, clock: Clock) -> Container:
    boot.data_dir.mkdir(parents=True, exist_ok=True)
    app_db = Database(boot.data_dir / "app.db", "app")
    runs_db = Database(boot.data_dir / "runs.db", "runs")
    app_db.migrate()
    runs_db.migrate()
    handles.attach_sqlite(runs_db)

    store = SettingsStore(db=app_db, bus=bus, clock=clock)
    recorder = RunRecorder(runs_db, bus, clock, settings_revision=lambda: store.revision)
    container_ref: dict[str, Container] = {}

    async def persist_paused(paused: set[str]) -> None:
        await app_db.run(container_ref["c"].kv_set, PAUSED_JOBS_KEY, sorted(paused))

    scheduler = Scheduler(clock, recorder, bus, on_pause_change=persist_paused)
    c = Container(
        boot=boot,
        clock=clock,
        bus=bus,
        logging=handles,
        app_db=app_db,
        runs_db=runs_db,
        settings=store,
        recorder=recorder,
        scheduler=scheduler,
        started_at=clock.now(),
    )
    container_ref["c"] = c
    return c


def _apply_logging(c: Container, settings: Settings) -> None:
    c.logging.set_levels(settings.logging.level, dict(settings.logging.component_levels))


def create_app(
    boot: Bootstrap,
    *,
    bus: EventBus | None = None,
    logging_handles: LoggingHandles | None = None,
    clock: Clock | None = None,
) -> FastAPI:
    bus = bus or EventBus()
    clock = clock or SystemClock()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        bus.bind(asyncio.get_running_loop())
        handles = logging_handles or setup_logging(bus, boot.log_level, boot.tz)
        c = build_container(boot, bus, handles, clock)
        app.state.container = c

        c.settings.load()
        _apply_logging(c, c.settings.current)
        c.settings.subscribe("logging", lambda old, new, paths: _apply_logging(c, new))
        interrupted = await c.recorder.mark_interrupted()
        if interrupted:
            log.warning("%d run(s) were interrupted by the previous shutdown", interrupted)

        system_jobs.register(c)
        for job_id in c.kv_get(PAUSED_JOBS_KEY, []):
            if job_id in c.scheduler.jobs:
                c.scheduler.jobs[job_id].paused = True

        if boot.safe_mode:
            log.warning("Safe mode: the scheduler is not started and EMHASS mode is forced off")
        elif c.settings.load_errors:
            log.error("Settings are invalid: the scheduler is not started until they are fixed")
        else:
            c.scheduler.start()

        def start_on_valid_settings(old: Settings, new: Settings, paths: list[str]) -> None:
            if not boot.safe_mode and not c.scheduler.started:
                c.scheduler.start()

        c.settings.subscribe("", start_on_valid_settings)
        log.info("Ready on port %d", boot.port)
        try:
            yield
        finally:
            log.info("Shutting down")
            await c.scheduler.stop()
            handles.close() if logging_handles is None else (handles.sqlite and handles.sqlite.close())
            c.app_db.close()
            c.runs_db.close()

    app = FastAPI(
        title="EMHASS Lens",
        version=boot.version,
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )
    for module in (meta, logs, settings, jobs, runs):
        app.include_router(module.router)
    if boot.static_dir is not None:
        app.mount("/", UIFiles(directory=boot.static_dir, html=True), name="ui")
    return app
