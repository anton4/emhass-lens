"""Backups: the pre-backup check, a restored copy (empty runs.db next to an app.db that remembers run numbers),
and the newest Home Assistant backup that contains the App."""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from emhass_lens.backup_pre import MARKER, prepare
from emhass_lens.core.clock import FakeClock
from emhass_lens.db.conn import Database
from tests.test_phase1 import make_client, run_job
from tests.world import World, make_plan

NOW = datetime(2026, 10, 9, 11, 0, tzinfo=UTC)


def container(client):
    return client.app.state.container  # type: ignore[attr-defined]


def test_backup_pre_checkpoints_and_reports_the_state_of_app_db(tmp_path: Path) -> None:
    db = Database(tmp_path / "app.db", "app")
    db.migrate()
    db.execute("INSERT INTO kv (key, value_json, updated_at) VALUES ('k', '1', 'x')")
    assert (tmp_path / "app.db-wal").stat().st_size > 0
    marker = prepare(tmp_path, version="1.2.3")
    assert marker["quick_check"] == "ok" and marker["app_version"] == "1.2.3"
    assert (tmp_path / "app.db-wal").stat().st_size == 0  # checkpointed and truncated
    db.close()
    (tmp_path / "app.db").write_bytes(b"this is not a database at all, really not" * 100)
    broken = prepare(tmp_path)
    assert str(broken["quick_check"]).startswith("error:")
    assert prepare(tmp_path / "nowhere")["quick_check"] == "missing"


def test_a_restored_copy_continues_run_numbers_after_the_lost_history(tmp_path: Path) -> None:
    clock = FakeClock(NOW)
    with make_client(tmp_path, World(), clock) as client:
        plan = make_plan(
            NOW, {"load_cost_forecast": [0.1] * 4, "prod_price_forecast": [0.05] * 4, "pv_power_forecast": [0] * 4}
        )
        container(client).extras["emhass"]._store_plan(plan["generated_at"], "app", 57, {"status": "ok"}, plan)
        assert client.get("/api/storage").json()["restored"] is None
    # the backup had app.db (with its marker) but not runs.db
    (tmp_path / MARKER).write_text(json.dumps({"at": "2026-10-08T03:00:00+00:00", "quick_check": "ok"}))
    for suffix in ("", "-wal", "-shm"):
        (tmp_path / f"runs.db{suffix}").unlink(missing_ok=True)
    clock.set(NOW + timedelta(days=1))
    with make_client(tmp_path, World(), clock) as client:
        placeholder = client.get("/api/runs/57").json()
        assert placeholder["job"] == "system.restore" and placeholder["pinned"] == 1
        assert "up to #57" in placeholder["summary"]
        restored = client.get("/api/storage").json()["restored"]
        assert restored["last_run_id"] == 57 and restored["backup_taken_at"] == "2026-10-08T03:00:00+00:00"
        assert restored["acknowledged"] is False
        new_run = run_job(client, "system.heartbeat")
        assert new_run["id"] > 57
        run_job(client, "health.evaluate")
        assert "restore.recent" in {p["key"] for p in client.get("/api/problems").json()["active"]}
        assert client.post("/api/storage/restore-ack").json()["restored"]["acknowledged"] is True
        run_job(client, "health.evaluate")
        assert "restore.recent" not in {p["key"] for p in client.get("/api/problems").json()["active"]}
    # a plain restart is not a restore
    with make_client(tmp_path, World(), clock) as client:
        runs = client.get("/api/runs", params={"job": "system.restore"}).json()
        assert len(runs) == 1


def backup(date: datetime, *addons: str, name: str = "Full Backup") -> dict:
    return {
        "slug": "abc",
        "name": name,
        "date": date.isoformat(),
        "type": "full",
        "size": 42.5,
        "content": {"addons": list(addons)},
    }


def test_the_newest_backup_that_contains_the_app_is_reported_and_judged(tmp_path: Path) -> None:
    clock = FakeClock(NOW)
    world = World()
    world.supervisor_backups = [
        backup(NOW - timedelta(days=1), "local_emhass_lens", "5b918bf2_emhass"),
        backup(NOW - timedelta(hours=2), "5b918bf2_emhass", name="partial without us"),
    ]
    with make_client(tmp_path, world, clock, supervisor_token="t", ingress_ip="testclient") as client:
        run_job(client, "system.heartbeat")
        status = client.get("/api/storage").json()["backup"]
        assert status["available"] is True and status["count"] == 1
        assert status["newest_name"] == "Full Backup" and status["newest_size_mb"] == 42.5 and status["stale"] is False

        clock.set(NOW + timedelta(days=4))
        run_job(client, "system.heartbeat")
        status = client.get("/api/storage").json()["backup"]
        assert status["stale"] is True
        run_job(client, "health.evaluate")
        problems = {p["key"]: p for p in client.get("/api/problems").json()["active"]}
        assert "backup.stale" in problems and "Google Drive Backup" in problems["backup.stale"]["hint"]

        world.supervisor_lists_backups = False
        run_job(client, "system.heartbeat")
        status = client.get("/api/storage").json()["backup"]
        assert status["available"] is False and "refused to list backups" in status["reason"]
        run_job(client, "health.evaluate")
        assert "backup.stale" not in {p["key"] for p in client.get("/api/problems").json()["active"]}
