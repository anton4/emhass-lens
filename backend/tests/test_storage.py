"""Storage cleanup: day-based retention with the pin exemption, size budgets, compaction and the overview."""

import gzip
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from emhass_lens.core.clock import FakeClock, iso
from emhass_lens.db.conn import PageStats
from emhass_lens.services.storage import RUNS_LADDER, next_day_after, should_vacuum
from emhass_lens.settings.model import Settings
from tests.test_phase1 import make_client, run_job
from tests.world import World

NOW = datetime(2026, 10, 9, 11, 0, tzinfo=UTC)


def container(client: TestClient):
    return client.app.state.container  # type: ignore[attr-defined]


def add_run(
    client: TestClient, days_ago: float, *, pinned: bool = False, artifacts: int = 1, logs: int = 3, bulk: int = 0
) -> int:
    db = container(client).runs_db
    at = iso(NOW - timedelta(days=days_ago))
    run_id = db.execute(
        "INSERT INTO run (job, trigger, started_at, finished_at, duration_ms, outcome, summary, pinned) "
        "VALUES ('demo', 'manual', ?, ?, 1, 'ok', 'x', ?)",
        (at, at, int(pinned)),
    ).lastrowid
    assert run_id is not None
    blob = gzip.compress(json.dumps({"x": "y" * bulk}).encode())
    db.executemany(
        "INSERT INTO run_artifact (run_id, kind, created_at, size, gz) VALUES (?,?,?,?,?)",
        [(run_id, f"k{i}", at, 10 + bulk, blob) for i in range(artifacts)],
    )
    db.executemany(
        "INSERT INTO log (ts, level, component, msg, run_id) VALUES (?,?,?,?,?)",
        [(at, "INFO", "test", "m" * max(1, bulk), run_id) for _ in range(logs)],
    )
    return int(run_id)


def counts(client: TestClient, run_id: int) -> tuple[int, int, int]:
    db = container(client).runs_db
    run = db.query_one("SELECT count(*) AS n FROM run WHERE id = ?", (run_id,))
    arts = db.query_one("SELECT count(*) AS n FROM run_artifact WHERE run_id = ?", (run_id,))
    logs = db.query_one("SELECT count(*) AS n FROM log WHERE run_id = ?", (run_id,))
    return (run["n"] if run else 0, arts["n"] if arts else 0, logs["n"] if logs else 0)


def test_cleanup_deletes_old_rows_and_keeps_pinned_runs_with_logs_and_details(tmp_path: Path) -> None:
    clock = FakeClock(NOW)
    with make_client(tmp_path, World(), clock) as client:
        old_pinned = add_run(client, 40, pinned=True)
        middle = add_run(client, 10)
        fresh = add_run(client, 1)
        run = run_job(client, "maintenance.retention")
        assert run["outcome"] == "ok", run
        assert counts(client, old_pinned) == (1, 1, 3)  # pinned: run, details and logs all stay
        assert counts(client, middle) == (1, 0, 0)  # 10 days: the summary stays, details (7 d) and logs (7 d) go
        assert counts(client, fresh) == (1, 1, 3)
        removed = client.get("/api/storage").json()["last_cleanup"]["removed"]
        assert removed["run_artifact"] == 1 and removed["log"] == 3 and removed["run"] == 0
        assert "Removed" in run["summary"] and "log lines" in run["summary"]


def test_cleanup_prunes_problem_history_sessions_and_settings_versions(tmp_path: Path) -> None:
    clock = FakeClock(NOW)
    with make_client(tmp_path, World(), clock) as client:
        db = container(client).app_db
        for days, ended in ((100, True), (10, True), (100, False)):
            start = iso(NOW - timedelta(days=days + 1))
            db.execute(
                "INSERT INTO problem_event (key, severity, title, started_at, ended_at) "
                "VALUES ('k', 'warning', 't', ?, ?)",
                (start, iso(NOW - timedelta(days=days)) if ended else None),
            )
        for days, ended in ((200, True), (200, False), (5, True)):
            db.execute(
                "INSERT INTO market_session (direction, started_at, updated_at, ended_at) VALUES ('sell', ?, ?, ?)",
                (iso(NOW - timedelta(days=days + 1)), iso(NOW), iso(NOW - timedelta(days=days)) if ended else None),
            )
        doc = Settings().model_dump_json()
        db.executemany(
            "INSERT INTO settings_revision (created_at, source, schema_version, doc_json, diff_json) "
            "VALUES (?, 'ui', 3, ?, '[]')",
            [(iso(NOW - timedelta(days=40, minutes=i)), doc) for i in range(130)],
        )
        current = container(client).settings.revision
        run = run_job(client, "maintenance.retention")
        assert run["outcome"] == "ok", run
        mine = db.query("SELECT ended_at FROM problem_event WHERE key = 'k' ORDER BY id")
        assert len(mine) == 2 and sum(1 for r in mine if r["ended_at"] is None) == 1
        assert db.query_one("SELECT count(*) AS n FROM market_session")["n"] == 2  # type: ignore[index]
        kept = db.query("SELECT id FROM settings_revision ORDER BY id")
        assert len(kept) == 101  # the newest 100 plus the current revision (the oldest here)
        assert current in {r["id"] for r in kept}
        removed = client.get("/api/storage").json()["last_cleanup"]["removed"]
        assert removed["problem_event"] == 1 and removed["market_session"] == 1 and removed["settings_revision"] == 30


def test_budget_trims_the_oldest_day_first_in_ladder_order_and_respects_floors(tmp_path: Path) -> None:
    clock = FakeClock(NOW)
    with make_client(tmp_path, World(), clock) as client:
        storage = container(client).extras["storage"]
        runs = {days: add_run(client, days, artifacts=2, logs=40, bulk=3000) for days in (4, 3, 2, 0.5)}
        baseline = container(client).runs_db.page_stats().data_bytes
        storage.budget_bytes = lambda name: baseline - 150_000 if name == "runs.db" else 10**12  # type: ignore[method-assign]
        run = run_job(client, "maintenance.retention")
        assert run["outcome"] == "ok", run
        trimmed = client.get("/api/storage").json()["last_cleanup"]["trimmed"]["runs.db"]
        assert trimmed.get("log", 0) > 0
        # the oldest day's logs went first; the half-day-old run is inside the one-day floor and untouched
        assert counts(client, runs[4])[2] == 0
        assert counts(client, runs[0.5]) == (1, 2, 40)
        # logs are cut before any run detail, so artifacts of the old runs only go when the logs weren't enough
        if "run_artifact" not in trimmed:
            assert counts(client, runs[4])[1] == 2
        assert "over budget, cut runs.db" in run["summary"]


def test_a_budget_that_cannot_be_met_within_the_floors_is_reported(tmp_path: Path) -> None:
    clock = FakeClock(NOW)
    with make_client(tmp_path, World(), clock) as client:
        add_run(client, 0.2, logs=200, bulk=2000)
        storage = container(client).extras["storage"]
        storage.budget_bytes = lambda name: 1 if name == "runs.db" else 10**12  # type: ignore[method-assign]
        run = run_job(client, "maintenance.retention")
        assert "still over budget: runs.db" in run["summary"]
        run_job(client, "health.evaluate")
        keys = {p["key"] for p in client.get("/api/problems").json()["active"]}
        assert "storage.over_budget.runs.db" in keys


def test_should_vacuum_thresholds_and_day_boundaries() -> None:
    assert should_vacuum(PageStats(4096, 20_000, 5_000))  # 20 MiB free, 25 %
    assert not should_vacuum(PageStats(4096, 20_000, 3_000))  # 12 MiB: below 16 MiB
    assert not should_vacuum(PageStats(4096, 200_000, 5_000))  # 20 MiB but only 2.5 %
    assert not should_vacuum(PageStats(4096, 0, 0))
    assert next_day_after("2026-10-09T23:59:00.000+00:00", False) == "2026-10-10T00:00:00.000+00:00"
    assert (
        next_day_after("2026-10-09T02:00:00+03:00", False) == "2026-10-09T00:00:00.000+00:00"
    )  # 23:00 UTC the day before
    assert next_day_after("2026-10-09", True) == "2026-10-10"
    assert RUNS_LADDER[0].table == "log"


def test_compact_shrinks_the_file_and_is_skipped_without_disk_space(tmp_path: Path) -> None:
    clock = FakeClock(NOW)
    with make_client(tmp_path, World(), clock) as client:
        c = container(client)
        add_run(client, 1, logs=1500, bulk=3000)  # ~4.5 MB of log text
        c.runs_db.execute("DELETE FROM log")
        c.runs_db.checkpoint()
        before = c.runs_db.size_parts()["db"]
        assert c.runs_db.page_stats().freelist_count > 0
        run = run_job(client, "maintenance.compact")
        assert run["outcome"] == "ok", run
        after = c.runs_db.size_parts()["db"]
        assert after < before
        last = client.get("/api/storage").json()["last_compact"]
        assert last["databases"]["runs.db"]["ran"] is True and last["databases"]["runs.db"]["after_bytes"] == after
        assert run["summary"].startswith("Compacted runs.db")

        c.extras["storage"].disk = lambda: (0, 0)  # type: ignore[method-assign]
        run = run_job(client, "maintenance.compact")
        assert "not compacted: disk has 0 MiB free" in run["summary"]


def test_storage_overview_api(tmp_path: Path) -> None:
    clock = FakeClock(NOW)
    with make_client(tmp_path, World(), clock) as client:
        add_run(client, 1)
        body = client.get("/api/storage").json()
        assert body["data_dir"] == str(tmp_path) and body["disk_total_bytes"] > 0
        assert body["dbstat"] is True
        by_name = {d["name"]: d for d in body["databases"]}
        runs = by_name["runs.db"]
        assert runs["backed_up"] is False and by_name["app.db"]["backed_up"] is True
        assert runs["budget_bytes"] == 300 * 1024 * 1024 and runs["over_budget"] is False
        tables = {t["name"]: t for t in runs["tables"]}
        assert tables["log"]["rows"] >= 3 and tables["log"]["bytes"] > 0 and tables["log"]["oldest"] is not None
        assert (
            body["backup"]["available"] is False and "not running as a Home Assistant App" in body["backup"]["reason"]
        )
        assert body["restored"] is None


def test_retention_rejects_details_kept_longer_than_summaries_and_migrates_v2(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="Keep run details"):
        Settings(storage={"retention": {"artifacts_days": 40, "runs_days": 30}})  # type: ignore[arg-type]
    clock = FakeClock(NOW)
    with make_client(tmp_path, World(), clock) as client:
        db = container(client).app_db
        doc = Settings().model_dump(mode="json")
        doc.pop("storage")
        doc["logging"]["retention"] = {"logs_days": 3, "artifacts_days": 2, "runs_days": 9}
        db.execute(
            "INSERT INTO settings_revision (created_at, source, schema_version, doc_json, diff_json) "
            "VALUES ('x', 'ui', 2, ?, '[]')",
            (json.dumps(doc),),
        )
    with make_client(tmp_path, World(), clock) as client:
        settings = client.get("/api/settings").json()["settings"]
        assert settings["storage"]["retention"] == {
            "logs_days": 3,
            "artifacts_days": 2,
            "runs_days": 9,
            "problems_days": 90,
            "sessions_days": 180,
            "settings_revisions": 100,
        }
        assert "retention" not in settings["logging"]
