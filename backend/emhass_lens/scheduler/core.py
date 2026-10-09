"""One asyncio scheduler for every job in the App.

- Each job has a trigger, a lock and a grace period.
- A job that is still running when it is due again is skipped (recorded as skipped:overlap).
- A fire that comes later than the grace period (host suspended, loop blocked) is recorded as
  "missed" and not executed, so a scheduler that didn't fire shows up in the Runs list.
- Jobs can be paused, resumed and run on demand. Paused jobs persist in app.db.
"""

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from emhass_lens.core.bus import EventBus
from emhass_lens.core.clock import Clock, iso
from emhass_lens.runs.recorder import Run, RunRecorder
from emhass_lens.scheduler.triggers import Trigger

log = logging.getLogger("emhass_lens.scheduler")

MAX_SLEEP_S = 30.0  # wake up at least this often to notice clock jumps


@dataclass
class JobContext:
    run: Run | None
    trigger: str
    scheduled_at: datetime | None
    params: dict[str, Any]


JobFunc = Callable[[JobContext], Awaitable[None]]


@dataclass
class Job:
    id: str
    title: str
    description: str
    trigger: Trigger
    func: JobFunc
    grace: timedelta = timedelta(seconds=60)
    record: bool = True  # False for chatty housekeeping jobs that shouldn't fill the Runs list
    mode: Callable[[], str | None] | None = None  # e.g. EMHASS mode, stored with each run
    paused: bool = False
    next_fire: datetime | None = None
    last_started: datetime | None = None
    last_finished: datetime | None = None
    last_outcome: str | None = None
    last_run_id: int | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    @property
    def running(self) -> bool:
        return self.lock.locked()

    def info(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "trigger": self.trigger.describe(),
            "paused": self.paused,
            "running": self.running,
            "next_run": iso(self.next_fire),
            "last_started": iso(self.last_started),
            "last_finished": iso(self.last_finished),
            "last_outcome": self.last_outcome,
            "last_run_id": self.last_run_id,
            "grace_s": int(self.grace.total_seconds()),
        }


class Scheduler:
    def __init__(
        self,
        clock: Clock,
        recorder: RunRecorder,
        bus: EventBus,
        on_pause_change: Callable[[set[str]], Awaitable[None]] | None = None,
    ) -> None:
        self.clock = clock
        self.recorder = recorder
        self.bus = bus
        self.jobs: dict[str, Job] = {}
        self._wake = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._running: set[asyncio.Task[None]] = set()
        self._on_pause_change = on_pause_change
        self.started = False

    # --- registry ----------------------------------------------------------------------------------
    def add(self, job: Job) -> Job:
        if job.id in self.jobs:
            raise ValueError(f"duplicate job {job.id}")
        job.next_fire = job.trigger.next_after(self.clock.now())
        self.jobs[job.id] = job
        return job

    def retime(self, job_id: str, trigger: Trigger | None = None) -> None:
        """Recompute the next fire time (after a settings change or a dynamic job's own update)."""
        job = self.jobs[job_id]
        if trigger is not None:
            job.trigger = trigger
        job.next_fire = job.trigger.next_after(self.clock.now())
        self._publish(job)
        self._wake.set()

    async def set_paused(self, job_id: str, paused: bool) -> Job:
        job = self.jobs[job_id]
        job.paused = paused
        log.info("Job %s %s", job_id, "paused" if paused else "resumed")
        if not paused:
            job.next_fire = job.trigger.next_after(self.clock.now())
        self._publish(job)
        if self._on_pause_change:
            await self._on_pause_change({j.id for j in self.jobs.values() if j.paused})
        self._wake.set()
        return job

    # --- execution ------------------------------------------------------------------------------------
    def run_now(self, job_id: str, params: dict[str, Any] | None = None) -> asyncio.Task[None]:
        """Start a job immediately (ignores pause). Overlap still applies."""
        job = self.jobs[job_id]
        return self._fire(job, trigger="manual", scheduled_at=None, params=params or {})

    async def run_pending(self) -> list[asyncio.Task[None]]:
        """Fire every due job once. The loop calls this; tests call it with a FakeClock."""
        now = self.clock.now()
        started: list[asyncio.Task[None]] = []
        for job in list(self.jobs.values()):
            due = job.next_fire
            if job.paused or due is None or due > now:
                continue
            job.next_fire = job.trigger.next_after(now)  # skip any further missed occurrences
            lateness = now - due
            late_s, grace_s = int(lateness.total_seconds()), int(job.grace.total_seconds())
            if lateness > job.grace:
                log.warning("Job %s missed its %s run by %ds", job.id, iso(due), late_s)
                if job.record:
                    job.last_outcome = "missed"
                    job.last_run_id = await self.recorder.record(
                        job.id,
                        "schedule",
                        "missed",
                        summary=f"Fired {late_s} s late (grace {grace_s} s)",
                        scheduled_at=due,
                    )
                self._publish(job)
                continue
            started.append(self._fire(job, trigger="schedule", scheduled_at=due, params={}))
        return started

    def _fire(
        self, job: Job, trigger: str, scheduled_at: datetime | None, params: dict[str, Any]
    ) -> asyncio.Task[None]:
        task = asyncio.create_task(self._execute(job, trigger, scheduled_at, params), name=f"job:{job.id}")
        self._running.add(task)
        task.add_done_callback(self._running.discard)
        return task

    async def _execute(self, job: Job, trigger: str, scheduled_at: datetime | None, params: dict[str, Any]) -> None:
        if job.lock.locked():
            log.info("Job %s is still running; skipping this %s run", job.id, trigger)
            if job.record:
                job.last_run_id = await self.recorder.record(
                    job.id,
                    trigger,
                    "skipped",
                    summary="Previous run still in progress",
                    scheduled_at=scheduled_at,
                )
            return
        async with job.lock:
            job.last_started = self.clock.now()
            self._publish(job)
            mode = job.mode() if job.mode else None
            try:
                if job.record:
                    async with self.recorder.start(job.id, trigger, mode, scheduled_at) as run:
                        job.last_run_id = run.id
                        await job.func(JobContext(run, trigger, scheduled_at, params))
                    job.last_outcome = run.outcome
                else:
                    await job.func(JobContext(None, trigger, scheduled_at, params))
                    job.last_outcome = "ok"
            except asyncio.CancelledError:
                job.last_outcome = "cancelled"
                raise
            except Exception:
                job.last_outcome = "error"
                log.exception("Job %s failed", job.id)
            finally:
                job.last_finished = self.clock.now()
                self._publish(job)

    # --- loop ------------------------------------------------------------------------------------------
    def start(self) -> None:
        if self._task is None:
            self.started = True
            self._task = asyncio.create_task(self._loop(), name="scheduler")
            log.info("Scheduler started with %d jobs", len(self.jobs))

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        for task in list(self._running):
            task.cancel()
        if self._running:
            await asyncio.gather(*self._running, return_exceptions=True)
        self.started = False

    async def _loop(self) -> None:
        while True:
            try:
                await self.run_pending()
            except Exception:
                log.exception("Scheduler tick failed")
            now = self.clock.now()
            upcoming = [j.next_fire for j in self.jobs.values() if not j.paused and j.next_fire]
            delay = MAX_SLEEP_S
            if upcoming:
                delay = min(delay, max(0.0, (min(upcoming) - now).total_seconds()))
            self._wake.clear()
            await self.clock.wait(self._wake, delay + 0.005)

    def _publish(self, job: Job) -> None:
        self.bus.publish("job.updated", job.info())

    def info(self) -> list[dict[str, Any]]:
        return [job.info() for job in self.jobs.values()]
