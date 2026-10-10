"""Whether a newer EMHASS Lens exists, from two sources:

- the Supervisor (`/addons/self/info`: `version_latest`, `update_available`): what Home Assistant can install now;
- GitHub: the version in the repository's `emhass_lens/config.yaml` on main, counted only once its image for this
  machine's architecture is in the registry (ghcr.io), so it never points at a release whose image is still building.

The header shows "Update to x.y.z" when Home Assistant can install it, and "x.y.z released" (Check for updates) when
GitHub has a ready release the Supervisor hasn't picked up yet: Home Assistant refreshes its App store on its own
schedule.
"""

import logging
import platform
import re
from datetime import datetime
from typing import TYPE_CHECKING, Any

import httpx

from emhass_lens.clients.supervisor import SupervisorError
from emhass_lens.core.clock import iso
from emhass_lens.scheduler.core import JobContext

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.updates")

CONFIG_URL = "https://raw.githubusercontent.com/anton4/emhass-lens/main/emhass_lens/config.yaml"
REGISTRY = "https://ghcr.io"
MANIFEST_TYPES = ", ".join(
    (
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
    )
)
_VERSION = re.compile(r'^version:\s*"?([0-9][^"\s#]*)"?', re.MULTILINE)
_IMAGE = re.compile(r'^image:\s*"?ghcr\.io/([^"\s#]+)"?', re.MULTILINE)


def version_tuple(version: str | None) -> tuple[int, ...] | None:
    """(0, 3, 16) from "0.3.16"; None for "dev", "test" and other non-releases."""
    if not version or not re.fullmatch(r"\d+(\.\d+)*", version):
        return None
    return tuple(int(part) for part in version.split("."))


def newer(candidate: str | None, installed: str | None) -> bool:
    a, b = version_tuple(candidate), version_tuple(installed)
    return a is not None and b is not None and a > b


def parse_config(text: str) -> tuple[str | None, str | None]:
    """(version, image template like "anton4/emhass-lens-{arch}") from the App's config.yaml."""
    version = _VERSION.search(text)
    image = _IMAGE.search(text)
    return (version.group(1) if version else None), (image.group(1) if image else None)


def machine_arch() -> str:
    """The App's architecture name for this machine (the {arch} of the image)."""
    machine = platform.machine().lower()
    return "aarch64" if machine in ("aarch64", "arm64") else "amd64"


class UpdateService:
    def __init__(self, c: Container, http: httpx.AsyncClient) -> None:
        self.c = c
        self.http = http
        self.info: dict[str, Any] | None = None  # from the Supervisor
        self.published: dict[str, Any] | None = None  # from GitHub: {version, ready}
        self.checked_at: datetime | None = None

    async def check(self, ctx: JobContext | None = None) -> None:
        supervisor = self.c.extras["supervisor"]
        if not supervisor.available:
            return  # outside Home Assistant there is nothing to update from
        await self._supervisor(supervisor)
        await self._github()
        self.checked_at = self.c.clock.now()

    async def _supervisor(self, supervisor: Any) -> None:
        try:
            info = await supervisor.self_info()
        except SupervisorError as exc:
            log.debug("Reading the App's own info failed: %s", exc)
            return
        latest = info.get("version_latest")
        available = bool(info.get("update_available")) and bool(latest)
        before = self.info
        self.info = {"version_latest": latest, "update_available": available, "slug": info.get("slug")}
        if available and (before is None or before.get("version_latest") != latest or not before["update_available"]):
            log.info("EMHASS Lens %s can be installed (installed %s)", latest, self.c.boot.version)

    async def _github(self) -> None:
        try:
            resp = await self.http.get(CONFIG_URL)
            resp.raise_for_status()
            version, image = parse_config(resp.text)
            if not newer(version, self.c.boot.version) or not image:
                self.published = {"version": version, "ready": False}
                return
            if self.published and self.published.get("version") == version and self.published.get("ready"):
                return  # already known to be installable
            ready = await self._image_exists(image.replace("{arch}", machine_arch()), str(version))
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            log.debug("Checking GitHub for a newer version failed: %s", exc)
            return
        before = self.published
        self.published = {"version": version, "ready": ready}
        if ready and (before is None or before.get("version") != version or not before.get("ready")):
            log.info("EMHASS Lens %s is released on GitHub", version)

    async def _image_exists(self, image: str, version: str) -> bool:
        token = (await self.http.get(f"{REGISTRY}/token", params={"scope": f"repository:{image}:pull"})).json()["token"]
        head = await self.http.head(
            f"{REGISTRY}/v2/{image}/manifests/{version}",
            headers={"Authorization": f"Bearer {token}", "Accept": MANIFEST_TYPES},
        )
        return head.status_code == 200

    def status(self) -> dict[str, Any] | None:
        if not self.info and not self.published:
            return None
        info = self.info or {}
        published = self.published or {}
        slug = info.get("slug")
        version = published.get("version")
        released = bool(published.get("ready")) and newer(version, self.c.boot.version)
        return {
            "update_available": bool(info.get("update_available")),
            "version_latest": info.get("version_latest"),
            "addon_path": f"/hassio/addon/{slug}/info" if slug else None,
            # released on GitHub and installable, but Home Assistant hasn't picked it up yet
            "released_version": version if released and not info.get("update_available") else None,
            "store_path": "/hassio/store",
            "checked_at": iso(self.checked_at),
        }
