"""Run records: every job execution gets a row in runs.db, its artifacts and its log lines.

    async with recorder.start("mpc", trigger="schedule", mode="dry_run") as run:
        run.artifact("request", payload)
        run.summary = "96 slots, horizon 2026-10-09 14:15 → 2026-10-10 14:00"
        run.outcome = "dry_run"

Inside the block, every log line carries run.id (via a contextvar), so the UI can show the logs
of one run next to its inputs and outputs.
"""

import asyncio
import gzip
import json
import logging
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from emhass_lens.core.bus import EventBus
from emhass_lens.core.clock import Clock, iso
from emhass_lens.core.redact import redactor
from emhass_lens.db.conn import Database
from emhass_lens.logs.context import job_var, run_id_var

log = logging.getLogger("emhass_lens.runs")

FINAL_OUTCOMES = {
    "ok",
    "error",
    "skipped",
    "missed",
    "cancelled",
    "refused",
    "dry_run",
    "infeasible",
    "timeout",
    "noop",
}


class RunRefused(Exception):
    """Raised inside a run to stop it with outcome "refused" and a reason (not an error)."""


@dataclass
class Run:
    id: int
    job: str
    trigger: str
    mode: str | None
    started_at: datetime
    _recorder: RunRecorder
    outcome: str | None = None
    summary: str | None = None
    error: str | None = None
    _pending: list[asyncio.Task[None]] = field(default_factory=list)

    def artifact(self, kind: str, data: Any) -> None:
        """Store JSON-serialisable data with the run (gzipped, secrets masked)."""
        task = asyncio.ensure_future(self._recorder.add_artifact(self.id, kind, data))
        self._pending.append(task)

    async def flush(self) -> None:
        if self._pending:
            await asyncio.gather(*self._pending, return_exceptions=True)
            self._pending.clear()


class RunRecorder:
    def __init__(
        self, db: Database, bus: EventBus, clock: Clock, settings_revision: Callable[[], int | None] = lambda: None
    ) -> None:
        self.db = db
        self.bus = bus
        self.clock = clock
        self.settings_revision = settings_revision

    @asynccontextmanager
    async def start(
        self, job: str, trigger: str = "manual", mode: str | None = None, scheduled_at: datetime | None = None
    ) -> AsyncIterator[Run]:
        started = self.clock.now()
        started_mono = time.monotonic()
        run_id = await self.db.aexecute(
            "INSERT INTO run (job, trigger, mode, scheduled_at, started_at, outcome, settings_rev) "
            "VALUES (?,?,?,?,?, 'running', ?)",
            (job, trigger, mode, iso(scheduled_at), iso(started), self.settings_revision()),
        )
        run = Run(id=int(run_id or 0), job=job, trigger=trigger, mode=mode, started_at=started, _recorder=self)
        run_token = run_id_var.set(run.id)
        job_token = job_var.set(job)
        self.bus.publish("run.started", self._event(run))
        try:
            yield run
            if run.outcome is None:
                run.outcome = "ok"
        except RunRefused as exc:
            run.outcome = "refused"
            run.summary = run.summary or str(exc)
            log.warning("Run refused: %s", exc)
        except asyncio.CancelledError:
            run.outcome = "cancelled"
            raise
        except Exception as exc:
            run.outcome = "error"
            run.error = redactor.text(f"{type(exc).__name__}: {exc}")
            log.exception("Run failed: %s", exc)
        finally:
            await run.flush()
            if run.summary is None and run.error:
                run.summary = f"Failed: {run.error}"
            duration_ms = int((time.monotonic() - started_mono) * 1000)
            await self.db.aexecute(
                "UPDATE run SET finished_at=?, duration_ms=?, outcome=?, summary=?, error=? WHERE id=?",
                (iso(self.clock.now()), duration_ms, run.outcome, run.summary, run.error, run.id),
            )
            run_id_var.reset(run_token)
            job_var.reset(job_token)
            self.bus.publish("run.finished", {**self._event(run), "duration_ms": duration_ms})

    async def record(
        self,
        job: str,
        trigger: str,
        outcome: str,
        summary: str | None = None,
        scheduled_at: datetime | None = None,
        mode: str | None = None,
    ) -> int:
        """A run that never executed: skipped (still running) or missed (fired too late)."""
        now = iso(self.clock.now())
        run_id = await self.db.aexecute(
            "INSERT INTO run (job, trigger, mode, scheduled_at, started_at, finished_at, duration_ms, outcome, "
            "summary, settings_rev) VALUES (?,?,?,?,?,?,0,?,?,?)",
            (job, trigger, mode, iso(scheduled_at), now, now, outcome, summary, self.settings_revision()),
        )
        event = {"id": run_id, "job": job, "trigger": trigger, "outcome": outcome, "summary": summary}
        self.bus.publish("run.finished", event)
        return int(run_id or 0)

    async def add_artifact(self, run_id: int, kind: str, data: Any) -> None:
        raw = json.dumps(redactor.data(data), ensure_ascii=False, default=str).encode()
        blob = gzip.compress(raw, compresslevel=6)
        await self.db.aexecute(
            "INSERT INTO run_artifact (run_id, kind, created_at, size, gz) VALUES (?,?,?,?,?)",
            (run_id, kind, iso(self.clock.now()), len(raw), blob),
        )

    # --- reading -----------------------------------------------------------------------------------
    async def list(
        self, job: str | None = None, outcome: str | None = None, limit: int = 100, before: int | None = None
    ) -> list[dict[str, Any]]:
        return await self.db.aquery(
            "SELECT id, job, trigger, mode, scheduled_at, started_at, finished_at, duration_ms, outcome, "
            "summary, error, settings_rev, pinned FROM run "
            "WHERE (? IS NULL OR job = ?) AND (? IS NULL OR outcome = ?) AND (? IS NULL OR id < ?) "
            "ORDER BY id DESC LIMIT ?",
            (job, job, outcome, outcome, before, before, limit),
        )

    async def get(self, run_id: int) -> dict[str, Any] | None:
        run = await self.db.aquery_one("SELECT * FROM run WHERE id = ?", (run_id,))
        if run is None:
            return None
        run["artifacts"] = await self.db.aquery(
            "SELECT id, kind, created_at, size FROM run_artifact WHERE run_id = ? ORDER BY id", (run_id,)
        )
        return run

    async def artifact(self, run_id: int, kind: str) -> Any:
        row = await self.db.aquery_one(
            "SELECT gz FROM run_artifact WHERE run_id = ? AND kind = ? ORDER BY id DESC LIMIT 1", (run_id, kind)
        )
        if row is None:
            raise KeyError(kind)
        return json.loads(gzip.decompress(row["gz"]))

    async def set_pinned(self, run_id: int, pinned: bool) -> None:
        await self.db.aexecute("UPDATE run SET pinned = ? WHERE id = ?", (int(pinned), run_id))

    async def mark_interrupted(self) -> int:
        """Runs still 'running' from a previous process were cut off by a restart."""

        def go() -> int:
            cur = self.db.execute(
                "UPDATE run SET outcome='cancelled', error='App stopped during the run' WHERE outcome='running'"
            )
            return cur.rowcount

        return await self.db.run(go)

    @staticmethod
    def _event(run: Run) -> dict[str, Any]:
        return {
            "id": run.id,
            "job": run.job,
            "trigger": run.trigger,
            "mode": run.mode,
            "started_at": iso(run.started_at),
            "outcome": run.outcome or "running",
            "summary": run.summary,
            "error": run.error,
        }
