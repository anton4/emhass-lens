from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from emhass_lens.app import create_app
from emhass_lens.bootstrap import Bootstrap
from tests.test_phase1 import ticks


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


def test_the_ui_saves_with_post_only(client: TestClient) -> None:
    """Proxies in front of Home Assistant often refuse PUT and PATCH, so the UI saves through POST twins."""
    settings = client.get("/api/settings").json()["settings"]
    settings["prices"]["tariff"]["package"] = "vork4"
    saved = client.post("/api/settings/save", json={"base_revision": 1, "settings": settings})
    assert saved.status_code == 200, saved.text
    assert saved.json()["diff"] == [{"path": "prices.tariff.package", "old": "custom", "new": "vork4"}]
    changed = client.post("/api/settings/change", json={"base_revision": 2, "changes": {"emhass": {"mode": "dry_run"}}})
    assert changed.status_code == 200, changed.text
    stale = client.post("/api/settings/change", json={"base_revision": 2, "changes": {"emhass": {"mode": "live"}}})
    assert stale.status_code == 409


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
    for _ in ticks():
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


def test_environment_tokens_are_masked_in_logs(tmp_path: Path) -> None:
    import logging

    app = create_app(boot(tmp_path, ha_token="long-lived-token-abc123", safe_mode=True))
    with TestClient(app) as client:
        logging.getLogger("emhass_lens.test").warning("token is long-lived-token-abc123")
        lines = client.get("/api/logs", params={"q": "token is"}).json()
        assert lines[-1]["msg"] == "token is ********"


def test_retention_also_prunes_prices_forecasts_and_plans(tmp_path: Path) -> None:
    with TestClient(create_app(boot(tmp_path, safe_mode=True))) as client:
        started = client.post("/api/jobs/maintenance.retention/run").json()
        run: dict = {}
        for _ in ticks():
            run = client.get(f"/api/runs/{started['run_id']}").json()
            if run["outcome"] != "running":
                break
        assert run["outcome"] == "ok", run
        storage = client.get("/api/storage").json()
        last = storage["last_cleanup"]
        assert last["summary"] == run["summary"]
        assert {"price_slot", "forecast_snapshot", "plan_snapshot", "log", "run", "settings_revision"} <= set(
            last["removed"]
        )
        assert [d["name"] for d in storage["databases"]] == ["app.db", "runs.db"]


def test_a_stored_secret_is_shown_only_on_request_through_ingress(tmp_path: Path) -> None:
    with TestClient(create_app(boot(tmp_path / "a", supervisor_token="t", ingress_ip="testclient"))) as client:
        rev = client.get("/api/settings").json()["revision"]
        changes = {"forecast": {"ee": {"api_key": "abc123secret"}}}
        assert client.post("/api/settings/change", json={"base_revision": rev, "changes": changes}).status_code == 200
        assert client.get("/api/settings").json()["settings"]["forecast"]["ee"]["api_key"] == "********"

        shown = client.post("/api/settings/secret", json={"path": "forecast.ee.api_key"})
        assert shown.status_code == 200, shown.text
        assert shown.json() == {"path": "forecast.ee.api_key", "value": "abc123secret"}
        assert shown.headers["cache-control"] == "no-store"
        assert client.post("/api/settings/secret", json={"path": "emhass.base_url"}).status_code == 404

        lines = [e["msg"] for e in client.app.state.container.logging.ring.tail()]  # type: ignore[attr-defined]
        assert "Stored forecast.ee.api_key shown to unknown" in lines
        assert not any("abc123secret" in line for line in lines)

    # the direct port (not through Ingress) may not see it
    with TestClient(create_app(boot(tmp_path / "b", supervisor_token="t", ingress_ip="10.9.9.9"))) as client:
        assert client.post("/api/settings/secret", json={"path": "forecast.ee.api_key"}).status_code == 403


async def test_the_event_stream_ends_when_the_bus_announces_the_shutdown() -> None:
    """uvicorn drains open responses before the app's shutdown hook, so the stream must end by itself."""
    import asyncio
    from types import SimpleNamespace

    from emhass_lens.api.routes.logs import events
    from emhass_lens.core.bus import EventBus

    bus = EventBus()
    bus.bind(asyncio.get_running_loop())
    c = SimpleNamespace(bus=bus)

    async def never_disconnected() -> bool:
        return False

    request = SimpleNamespace(is_disconnected=never_disconnected)
    response = await events(c, request, "log")  # type: ignore[arg-type]
    iterator = response.body_iterator.__aiter__()
    assert str(await iterator.__anext__()).startswith("retry: 3000")
    # the subscription exists only once the generator runs past its first yield: ask for the next chunk first
    waiting = asyncio.ensure_future(iterator.__anext__())
    await asyncio.sleep(0.05)
    bus.publish("log", {"msg": "hello"})
    assert str(await asyncio.wait_for(waiting, 5)).startswith("event: log")
    waiting = asyncio.ensure_future(iterator.__anext__())
    await asyncio.sleep(0.05)
    bus.close()
    assert str(await asyncio.wait_for(waiting, 5)).startswith("event: shutdown")
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(iterator.__anext__(), 5)
