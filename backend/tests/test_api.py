from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from emhass_lens.app import create_app
from emhass_lens.bootstrap import Bootstrap


def boot(tmp_path: Path, **kwargs) -> Bootstrap:
    return Bootstrap(version="test", data_dir=tmp_path, static_dir=None, **kwargs)


@pytest.fixture
def client(tmp_path: Path):
    with TestClient(create_app(boot(tmp_path))) as c:
        yield c


def test_version_and_live(client: TestClient) -> None:
    assert client.get("/api/version").json()["version"] == "test"
    assert client.get("/api/health/live").json() == {"ok": True}


def test_status_reports_scheduler_and_mode(client: TestClient) -> None:
    status = client.get("/api/status").json()
    assert status["emhass_mode"] == "off"
    assert status["scheduler_running"] is True
    assert status["writable"] is True  # standalone
    assert status["settings_revision"] == 1


def test_settings_roundtrip_with_conflict_and_validation(client: TestClient) -> None:
    current = client.get("/api/settings").json()
    assert current["revision"] == 1
    ok = client.patch("/api/settings", json={"base_revision": 1, "changes": {"emhass": {"mode": "dry_run"}}})
    assert ok.status_code == 200, ok.text
    assert ok.json()["diff"] == [{"path": "emhass.mode", "old": "off", "new": "dry_run"}]
    stale = client.patch("/api/settings", json={"base_revision": 1, "changes": {"emhass": {"mode": "live"}}})
    assert stale.status_code == 409
    assert stale.json()["revision"] == 2
    bad = client.patch("/api/settings", json={"base_revision": 2, "changes": {"prices": {"tariff": {"vat_pct": -1}}}})
    assert bad.status_code == 422
    assert bad.json()["errors"][0]["loc"] == "prices.tariff.vat_pct"
    revisions = client.get("/api/settings/revisions").json()
    assert [r["id"] for r in revisions] == [2, 1]


def test_full_document_put_and_yaml_import_preview(client: TestClient) -> None:
    settings = client.get("/api/settings").json()["settings"]
    settings["prices"]["tariff"]["package"] = "vork4"
    put = client.put("/api/settings", json={"base_revision": 1, "settings": settings, "comment": "Võrk 4"})
    assert put.status_code == 200, put.text
    exported = client.get("/api/settings/export").text
    assert "package: vork4" in exported
    preview = client.post(
        "/api/settings/import", json={"yaml": exported.replace("vork4", "vork2"), "dry_run": True}
    ).json()
    assert preview["errors"] == []
    assert preview["diff"] == [{"path": "prices.tariff.package", "old": "vork4", "new": "vork2"}]


def test_schema_has_ui_hints(client: TestClient) -> None:
    schema = client.get("/api/settings/schema").json()
    vat = schema["properties"]["prices"]["properties"]["tariff"]["properties"]["vat_pct"]
    assert vat["ui"]["unit"] == "%"
    assert "$defs" not in schema


def test_jobs_listed_and_run_now_records_a_run(client: TestClient) -> None:
    jobs = {j["id"]: j for j in client.get("/api/jobs").json()}
    assert {"system.heartbeat", "maintenance.retention"} <= set(jobs)
    started = client.post("/api/jobs/system.heartbeat/run")
    assert started.status_code == 202
    assert started.json()["run_id"] is not None
    runs: list[dict] = []
    for _ in range(50):
        runs = client.get("/api/runs", params={"job": "system.heartbeat"}).json()
        if runs and runs[0]["outcome"] != "running":
            break
    assert runs[0]["outcome"] == "ok"
    assert runs[0]["summary"].startswith("Up ")
    detail = client.get(f"/api/runs/{runs[0]['id']}").json()
    assert detail["artifacts"] == []


def test_writes_only_through_ingress_under_supervisor(tmp_path: Path) -> None:
    app = create_app(boot(tmp_path, supervisor_token="t", ingress_ip="10.9.9.9"))
    with TestClient(app) as client:
        status = client.get("/api/status").json()
        assert status["writable"] is False
        denied = client.patch("/api/settings", json={"changes": {"emhass": {"mode": "live"}}})
        assert denied.status_code == 403
        assert "sidebar" in denied.json()["detail"]


def test_safe_mode_keeps_scheduler_stopped(tmp_path: Path) -> None:
    with TestClient(create_app(boot(tmp_path, safe_mode=True))) as client:
        status = client.get("/api/status").json()
        assert status["scheduler_running"] is False
        assert status["components"]["scheduler"]["detail"] == "Paused: safe mode"


def test_logs_endpoint_returns_recent_lines(client: TestClient) -> None:
    lines = client.get("/api/logs").json()
    assert any("Ready on port" in line["msg"] for line in lines)
