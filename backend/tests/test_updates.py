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
        assert any(line.startswith("EMHASS Lens 0.3.16 can be installed") for line in lines)

        world.supervisor_self = {**world.supervisor_self, "version_latest": "0.3.15", "update_available": False}
        run_job(client, "app.update_check")
        assert client.get("/api/status").json()["update"]["update_available"] is False


def test_outside_the_supervisor_there_is_nothing_to_say(tmp_path: Path) -> None:
    with make_client(tmp_path, World(), FakeClock(START)) as client:
        run_job(client, "app.update_check")
        assert client.get("/api/status").json()["update"] is None


def test_a_release_on_github_shows_once_its_image_is_built(tmp_path: Path) -> None:
    """Home Assistant hasn't refreshed its App store yet: GitHub knows 0.3.17 first."""
    world = World()
    world.supervisor_self = {"slug": "local_emhass_lens", "version": "0.3.16", "update_available": False}
    world.github_version = "0.3.17"
    with make_client(
        tmp_path, world, FakeClock(START), supervisor_token="t", ingress_ip="testclient", version="0.3.16"
    ) as client:
        run_job(client, "app.update_check")
        update = client.get("/api/status").json()["update"]
        assert update["released_version"] is None  # the image is still building
        assert world.ghcr_heads and world.ghcr_heads[-1].endswith("/manifests/0.3.17")

        world.ghcr_tags.add("0.3.17")
        run_job(client, "app.update_check")
        update = client.get("/api/status").json()["update"]
        assert update["released_version"] == "0.3.17" and update["store_path"] == "/hassio/store"
        assert update["update_available"] is False

        # Home Assistant picked it up: the install link takes over
        world.supervisor_self = {**world.supervisor_self, "version_latest": "0.3.17", "update_available": True}
        run_job(client, "app.update_check")
        update = client.get("/api/status").json()["update"]
        assert update["update_available"] is True and update["released_version"] is None

        heads = len(world.ghcr_heads)
        run_job(client, "app.update_check")
        assert len(world.ghcr_heads) == heads  # a ready release isn't looked up again


def test_versions_compare_as_numbers() -> None:
    from emhass_lens.services.updates import newer, parse_config, version_tuple

    assert newer("0.3.10", "0.3.9") and not newer("0.3.9", "0.3.10") and not newer("0.3.16", "0.3.16")
    assert version_tuple("dev") is None and not newer("0.4.0", "test")
    assert parse_config('version: "0.3.17"\nimage: ghcr.io/anton4/emhass-lens-{arch}\n') == (
        "0.3.17",
        "anton4/emhass-lens-{arch}",
    )
