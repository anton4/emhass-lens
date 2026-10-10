"""Whether Home Assistant has a newer EMHASS Lens to install, as the Supervisor sees it (`/addons/self/info`:
`version_latest`, `update_available`). That is exactly what the App store offers, so the header never points at a
version whose image isn't installable yet. The Supervisor refreshes its store on its own schedule; Add-on Store →
Check for updates makes it notice at once."""

import logging
from datetime import datetime
from typing import TYPE_CHECKING, Any

from emhass_lens.clients.supervisor import SupervisorError
from emhass_lens.core.clock import iso
from emhass_lens.scheduler.core import JobContext

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.updates")


class UpdateService:
    def __init__(self, c: Container) -> None:
        self.c = c
        self.info: dict[str, Any] | None = None
        self.checked_at: datetime | None = None

    async def check(self, ctx: JobContext | None = None) -> None:
        supervisor = self.c.extras["supervisor"]
        if not supervisor.available:
            return
        try:
            info = await supervisor.self_info()
        except SupervisorError as exc:
            log.debug("Reading the App's own info failed: %s", exc)
            return
        latest = info.get("version_latest")
        available = bool(info.get("update_available")) and bool(latest)
        before = self.info
        self.info = {
            "version": info.get("version"),
            "version_latest": latest,
            "update_available": available,
            "slug": info.get("slug"),
        }
        self.checked_at = self.c.clock.now()
        if available and (before is None or before.get("version_latest") != latest or not before["update_available"]):
            log.info("EMHASS Lens %s is available (installed %s)", latest, self.c.boot.version)

    def status(self) -> dict[str, Any] | None:
        if not self.info:
            return None
        slug = self.info.get("slug")
        return {
            "update_available": self.info["update_available"],
            "version_latest": self.info["version_latest"],
            "addon_path": f"/hassio/addon/{slug}/info" if slug else None,
            "checked_at": iso(self.checked_at),
        }
