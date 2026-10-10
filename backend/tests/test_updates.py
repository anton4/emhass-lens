"""The header's "update available": what the Supervisor says Home Assistant can install."""

from datetime import UTC, datetime
from pathlib import Path

from emhass_lens.core.clock import FakeClock
from tests.test_phase1 import make_client, run_job
from tests.world import World

START = datetime(2026, 10, 10, 15, 40, tzinfo=UTC)


def test_a_newer_version_is_shown_with_a_link_to_the_app_page(tmp_path: Path) -> None:
    world = World()
    world.supervisor_self = {
        "slug": "local_emhass_lens",
        "version": "0.3.15",
        "version_latest": "0.3.16",
        "update_available": True,
    }
    with make_client(tmp_path, world, FakeClock(START), supervisor_token="t", ingress_ip="testclient") as client:
        run_job(client, "app.update_check")
        update = client.get("/api/status").json()["update"]
        assert update["update_available"] is True and update["version_latest"] == "0.3.16"
        assert update["addon_path"] == "/hassio/addon/local_emhass_lens/info"
        lines = [e["msg"] for e in client.app.state.container.logging.ring.tail()]  # type: ignore[attr-defined]
        assert any(line.startswith("EMHASS Lens 0.3.16 is available") for line in lines)

        world.supervisor_self = {**world.supervisor_self, "version_latest": "0.3.15", "update_available": False}
        run_job(client, "app.update_check")
        assert client.get("/api/status").json()["update"]["update_available"] is False


def test_outside_the_supervisor_there_is_nothing_to_say(tmp_path: Path) -> None:
    with make_client(tmp_path, World(), FakeClock(START)) as client:
        run_job(client, "app.update_check")
        assert client.get("/api/status").json()["update"] is None
