import asyncio
from datetime import timedelta

from emhass_lens.core.bus import EventBus
from emhass_lens.core.clock import FakeClock
from emhass_lens.runs.recorder import RunRecorder
from emhass_lens.scheduler.core import Job, JobContext, Scheduler
from emhass_lens.scheduler.triggers import Manual, QuarterHour


def make(clock: FakeClock, recorder: RunRecorder, bus: EventBus) -> Scheduler:
    return Scheduler(clock, recorder, bus)


async def test_job_fires_on_its_quarter_offset_and_records_a_run(clock, recorder, bus) -> None:
    calls: list[JobContext] = []

    async def job(ctx: JobContext) -> None:
        calls.append(ctx)
        assert ctx.run is not None
        ctx.run.summary = "did it"

    scheduler = make(clock, recorder, bus)
    scheduler.add(Job(id="mpc", title="MPC", description="", trigger=QuarterHour(780), func=job))
    assert scheduler.jobs["mpc"].next_fire == clock.now() + timedelta(minutes=13)

    assert await scheduler.run_pending() == []  # 11:00:00, not due yet
    clock.advance(minutes=13)
    tasks = await scheduler.run_pending()
    await asyncio.gather(*tasks)

    assert len(calls) == 1
    assert calls[0].trigger == "schedule"
    runs = await recorder.list()
    assert [(r["job"], r["outcome"], r["summary"]) for r in runs] == [("mpc", "ok", "did it")]
    assert scheduler.jobs["mpc"].next_fire == clock.now() + timedelta(minutes=15)


async def test_overlapping_run_is_skipped_and_recorded(clock, recorder, bus) -> None:
    release = asyncio.Event()

    async def slow(ctx: JobContext) -> None:
        await release.wait()

    scheduler = make(clock, recorder, bus)
    scheduler.add(Job(id="slow", title="Slow", description="", trigger=Manual(), func=slow))
    first = scheduler.run_now("slow")
    await asyncio.sleep(0.01)
    second = scheduler.run_now("slow")
    await second
    release.set()
    await first

    outcomes = sorted(r["outcome"] for r in await recorder.list(job="slow"))
    assert outcomes == ["ok", "skipped"]


async def test_late_fire_beyond_grace_is_recorded_as_missed(clock, recorder, bus) -> None:
    ran = False

    async def job(ctx: JobContext) -> None:
        nonlocal ran
        ran = True

    scheduler = make(clock, recorder, bus)
    scheduler.add(Job(id="j", title="J", description="", trigger=QuarterHour(0), func=job, grace=timedelta(seconds=60)))
    clock.advance(minutes=15, seconds=90)  # host was suspended past the 11:15 fire
    await asyncio.gather(*await scheduler.run_pending())

    assert not ran
    [run] = await recorder.list(job="j")
    assert run["outcome"] == "missed"
    assert scheduler.jobs["j"].next_fire == clock.now().replace(minute=30, second=0)


async def test_failing_job_records_error_and_keeps_scheduling(clock, recorder, bus) -> None:
    async def boom(ctx: JobContext) -> None:
        raise RuntimeError("nope")

    scheduler = make(clock, recorder, bus)
    scheduler.add(Job(id="b", title="B", description="", trigger=QuarterHour(0), func=boom))
    clock.advance(minutes=15)
    await asyncio.gather(*await scheduler.run_pending())
    [run] = await recorder.list(job="b")
    assert run["outcome"] == "error"
    assert "RuntimeError: nope" in run["error"]
    assert scheduler.jobs["b"].last_outcome == "error"
    assert scheduler.jobs["b"].next_fire is not None


async def test_paused_job_does_not_fire(clock, recorder, bus) -> None:
    async def job(ctx: JobContext) -> None:
        raise AssertionError("should not run")

    scheduler = make(clock, recorder, bus)
    scheduler.add(Job(id="p", title="P", description="", trigger=QuarterHour(0), func=job))
    await scheduler.set_paused("p", True)
    clock.advance(minutes=15)
    assert await scheduler.run_pending() == []


async def test_loop_runs_with_real_clock_quickly() -> None:
    """Smoke test of the real loop: a manual run completes and the loop stops cleanly."""
    from emhass_lens.core.clock import SystemClock
    from emhass_lens.db.conn import Database

    bus = EventBus()
    bus.bind(asyncio.get_running_loop())
    db = Database(":memory:", "runs")
    db.migrate()
    scheduler = Scheduler(SystemClock(), RunRecorder(db, bus, SystemClock()), bus)
    done = asyncio.Event()

    async def job(ctx: JobContext) -> None:
        done.set()

    scheduler.add(Job(id="m", title="M", description="", trigger=Manual(), func=job))
    scheduler.start()
    scheduler.run_now("m")
    await asyncio.wait_for(done.wait(), 2)
    await scheduler.stop()


async def test_event_runs_are_recorded_even_for_unrecorded_jobs(clock, recorder, bus) -> None:
    seen: list[str] = []

    async def job(ctx: JobContext) -> None:
        seen.append(ctx.trigger)

    scheduler = make(clock, recorder, bus)
    scheduler.add(Job(id="e", title="E", description="", trigger=Manual(), func=job, record=False))
    await scheduler.run_now("e", {"x": 1}, trigger="event")
    assert seen == ["event"]
    [run] = await recorder.list(job="e")
    assert run["trigger"] == "event" and run["outcome"] == "ok"


async def test_a_coalescing_job_runs_once_more_with_the_newest_params(clock, recorder, bus) -> None:
    release = asyncio.Event()
    seen: list[dict] = []

    async def slow(ctx: JobContext) -> None:
        seen.append(dict(ctx.params))
        if len(seen) == 1:
            await release.wait()

    scheduler = make(clock, recorder, bus)
    scheduler.add(Job(id="c", title="C", description="", trigger=Manual(), func=slow, coalesce=True))
    first = scheduler.run_now("c", {"n": 1})
    await asyncio.sleep(0.01)
    await scheduler.run_now("c", {"n": 2}, trigger="event")  # queued, not skipped
    await scheduler.run_now("c", {"n": 3}, trigger="event")  # replaces the queued params
    release.set()
    await first
    assert seen == [{"n": 1}, {"n": 3}]
    outcomes = [r["outcome"] for r in await recorder.list(job="c")]
    assert sorted(outcomes) == ["ok", "ok"]  # no "skipped" record
