"""Phone messages through a Home Assistant notify service (Settings → Notifications → Mobile notify service)."""

import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.notify")


async def send_mobile(c: Container, message: str, *, title: str | None = None, dry_run: bool) -> dict[str, Any]:
    """Send `message` (or, in dry run, only record it). Never raises: the result says what happened.

    ok is True when sent, False when sending failed, None when nothing was sent (dry run, or no service set)."""
    service = c.settings.current.notifications.mobile_service
    result: dict[str, Any] = {"service": service or None, "message": message}
    if not service:
        return {**result, "ok": None, "skipped": "no mobile notify service configured"}
    if dry_run:
        return {**result, "ok": None, "dry_run": True}
    data: dict[str, Any] = {"message": message}
    if title:
        data["title"] = title
    try:
        await c.extras["ha"].call_service("notify", service.removeprefix("notify."), data)
        return {**result, "ok": True}
    except Exception as exc:
        log.warning("Sending a notification through %s failed: %s", service, exc)
        return {**result, "ok": False, "error": str(exc)}
