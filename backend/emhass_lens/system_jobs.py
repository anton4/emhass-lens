"""Housekeeping jobs: heartbeat, storage cleanup and compaction."""

import logging
from datetime import time, timedelta

from emhass_lens.container import Container
from emhass_lens.scheduler.core import Job, JobContext
from emhass_lens.scheduler.triggers import Daily, Manual, QuarterHour
from emhass_lens.services.storage import StorageService

log = logging.getLogger("emhass_lens.system")


def register(c: Container) -> None:
    storage = StorageService(c)
    c.extras["storage"] = storage

    async def heartbeat(ctx: JobContext) -> None:
        uptime = c.clock.now() - c.started_at
        hours, rest = divmod(int(uptime.total_seconds()), 3600)
        sizes = f"app.db {c.app_db.size_bytes() // 1024} KiB, runs.db {c.runs_db.size_bytes() // 1024} KiB"
        summary = f"Up {hours} h {rest // 60} min; {sizes}; {c.bus.subscriber_count} live viewers"
        try:
            await storage.backup_status(refresh=True)
        except Exception as exc:  # never let the Supervisor spoil the heartbeat
            log.debug("Backup status: %s", exc)
        log.debug("Heartbeat: %s", summary)
        if ctx.run:
            ctx.run.summary = summary

    async def cleanup(ctx: JobContext) -> None:
        await storage.cleanup(ctx, trigger=ctx.trigger)

    async def compact(ctx: JobContext) -> None:
        await storage.compact(ctx)

    c.scheduler.add(
        Job(
            id="system.heartbeat",
            title="Heartbeat",
            description="Proves the scheduler is alive; records uptime and database sizes.",
            trigger=QuarterHour(30),
            func=heartbeat,
        )
    )
    c.scheduler.add(
        Job(
            id="maintenance.retention",
            title="Storage cleanup",
            description="Deletes old rows, keeps each database within its size budget and compacts it when "
            "worthwhile (Settings → Storage).",
            trigger=Daily(time(3, 30), c.boot.tz),
            func=cleanup,
            grace=timedelta(hours=1),
        )
    )
    c.scheduler.add(
        Job(
            id="maintenance.compact",
            title="Compact databases",
            description="Runs VACUUM on both databases now. Needs free disk space of about their size; the App "
            "pauses for seconds to tens of seconds.",
            trigger=Manual(),
            func=compact,
        )
    )
