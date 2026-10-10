"""Housekeeping jobs: heartbeat and retention."""

import logging
from datetime import time, timedelta

from emhass_lens.container import Container
from emhass_lens.core.clock import iso
from emhass_lens.scheduler.core import Job, JobContext
from emhass_lens.scheduler.triggers import Daily, QuarterHour

log = logging.getLogger("emhass_lens.system")


def register(c: Container) -> None:
    async def heartbeat(ctx: JobContext) -> None:
        uptime = c.clock.now() - c.started_at
        hours, rest = divmod(int(uptime.total_seconds()), 3600)
        sizes = f"app.db {c.app_db.size_bytes() // 1024} KiB, runs.db {c.runs_db.size_bytes() // 1024} KiB"
        summary = f"Up {hours} h {rest // 60} min; {sizes}; {c.bus.subscriber_count} live viewers"
        log.debug("Heartbeat: %s", summary)
        if ctx.run:
            ctx.run.summary = summary

    async def retention(ctx: JobContext) -> None:
        keep = c.settings.current.logging.retention
        now = c.clock.now()
        log_cut = iso(now - timedelta(days=keep.logs_days))
        art_cut = iso(now - timedelta(days=keep.artifacts_days))
        run_cut = iso(now - timedelta(days=keep.runs_days))

        def prune() -> tuple[int, int, int]:
            logs = c.runs_db.execute("DELETE FROM log WHERE ts < ?", (log_cut,)).rowcount
            arts = c.runs_db.execute(
                "DELETE FROM run_artifact WHERE created_at < ? AND run_id NOT IN (SELECT id FROM run WHERE pinned = 1)",
                (art_cut,),
            ).rowcount
            runs = c.runs_db.execute("DELETE FROM run WHERE started_at < ? AND pinned = 0", (run_cut,)).rowcount
            c.runs_db.checkpoint()
            c.app_db.checkpoint()
            return logs, arts, runs

        logs, arts, runs = await c.runs_db.run(prune)
        summary = f"Removed {logs} log lines, {arts} run details and {runs} runs"
        x = c.extras
        if "prices" in x:
            slots = await c.app_db.run(x["prices"].prune, now)
            snapshots = await c.app_db.run(x["forecasts"].prune, now)
            plans = await c.app_db.run(x["emhass"].prune, 2000, now)
            summary += f"; {slots} old price slots, {snapshots} forecast snapshots, {plans} plans"
        if "measurements" in x:
            measured = await c.app_db.run(x["measurements"].prune, now)
            summary += f"; {measured} measurements"
        if "costfun" in x:
            compared = await c.app_db.run(x["costfun"].prune, now)
            summary += f"; {compared} cost function plans"
        if "sofar" in x:
            wear = await c.app_db.run(x["sofar"].prune, now)
            summary += f"; {wear} inverter write records"
        log.info(summary)
        if ctx.run:
            ctx.run.summary = summary

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
            title="Retention",
            description="Deletes old log lines, run details and runs (see Settings → Logging → Retention).",
            trigger=Daily(time(3, 30), c.boot.tz),
            func=retention,
            grace=timedelta(hours=1),
        )
    )
