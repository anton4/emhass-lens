import logging

from emhass_lens.core.bus import EventBus
from emhass_lens.core.redact import redactor
from emhass_lens.logs.setup import setup_logging
from emhass_lens.runs.recorder import RunRecorder, RunRefused


async def test_log_lines_inside_a_run_carry_its_id_and_secrets_are_masked(
    bus: EventBus, recorder: RunRecorder, runs_db
) -> None:
    handles = setup_logging(bus, "debug")
    handles.attach_sqlite(runs_db)
    redactor.set_secrets(["abcdef123456"])
    try:
        log = logging.getLogger("emhass_lens.test")
        async with recorder.start("demo") as run:
            log.info("calling with key %s", "abcdef123456")
            run.artifact("request", {"key": "abcdef123456", "n": 1})
        handles.sqlite.flush()  # type: ignore[union-attr]
        rows = runs_db.query("SELECT msg, run_id, component FROM log WHERE run_id = ?", (run.id,))
        assert rows == [{"msg": "calling with key ********", "run_id": run.id, "component": "test"}]
        assert await recorder.artifact(run.id, "request") == {"key": "********", "n": 1}
        ring = [e for e in handles.ring.tail() if e["run_id"] == run.id]
        assert ring[0]["msg"] == "calling with key ********"
    finally:
        redactor.set_secrets([])
        handles.close()


async def test_third_party_debug_stays_out_of_the_log(bus: EventBus) -> None:
    handles = setup_logging(bus, "debug")
    try:
        assert logging.getLogger("emhass_lens.ha").isEnabledFor(logging.DEBUG)
        assert not logging.getLogger("websockets.client").isEnabledFor(logging.DEBUG)
        assert not logging.getLogger("some_library").isEnabledFor(logging.DEBUG)
    finally:
        handles.close()


async def test_refused_and_failed_runs(recorder: RunRecorder) -> None:
    async with recorder.start("mpc") as run:
        raise RunRefused("SOC sensor unavailable")
    async with recorder.start("mpc") as run2:
        raise ValueError("bad payload")
    by_id = {r["id"]: r for r in await recorder.list()}
    assert by_id[run.id]["outcome"] == "refused"
    assert by_id[run.id]["summary"] == "SOC sensor unavailable"
    assert by_id[run2.id]["outcome"] == "error"
    assert by_id[run2.id]["error"] == "ValueError: bad payload"


async def test_an_artifact_over_the_cap_is_stored_as_a_truncated_note(recorder: RunRecorder, runs_db) -> None:
    async with recorder.start("demo") as run:
        run.artifact("big", {"blob": "x" * 700_000})
        run.artifact("small", {"n": 1})
    big = await recorder.artifact(run.id, "big")
    assert big["truncated"] is True and big["original_bytes"] > 700_000 and big["limit_bytes"] == 512 * 1024
    assert big["preview"].startswith('{"blob": "xxx')
    assert await recorder.artifact(run.id, "small") == {"n": 1}
    sizes = {
        r["kind"]: r["size"] for r in runs_db.query("SELECT kind, size FROM run_artifact WHERE run_id = ?", (run.id,))
    }
    assert sizes["big"] > 700_000 and sizes["small"] < 100  # size keeps the original byte count
