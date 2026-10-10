"""When EMHASS Lens retrains EMHASS's load model by itself: every night (or week) in a window, and right away when
the model can't serve the runs (a tuned model shorter than the horizon, or a changed lag count). Pure: `now`, the time
zone and the last fits are passed in."""

from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

WINDOW = timedelta(hours=3)
FAULT_RETRY = timedelta(hours=6)
WEEKLY_AGE = timedelta(days=6, hours=12)


def auto_fit_due(
    *,
    now: datetime,
    tz: ZoneInfo,
    auto_fit: str,
    hour: int,
    fit_on_fault: bool,
    last_fit_at: datetime | None,
    last_auto: dict[str, Any] | None,
    last_auto_at: datetime | None,
    fault: str | None,
) -> str | None:
    """Why a fit is due now ("nightly", "weekly", or the fault in words), or None.

    `last_fit_at` is the last successful fit by EMHASS Lens; `last_auto`/`last_auto_at` the last automatic attempt
    (successful or not) with its `fault` flag, so a failing fit isn't retried on every run."""
    if fault and fit_on_fault:
        recent = (
            last_auto is not None
            and bool(last_auto.get("fault"))
            and last_auto_at is not None
            and now - last_auto_at < FAULT_RETRY
        )
        if not recent:
            return f"the model can't serve the runs: {fault}"
    if auto_fit == "off":
        return None
    local = now.astimezone(tz)
    start = local.replace(hour=hour, minute=0, second=0, microsecond=0)
    if start > local:
        start -= timedelta(days=1)  # the window that began yesterday (one starting at 23:00 runs past midnight)
    if local - start >= WINDOW:
        return None
    if last_auto_at is not None and last_auto_at >= start:
        return None  # one attempt per night, even when it failed
    if auto_fit == "daily":
        if last_fit_at is not None and last_fit_at >= start:
            return None
        return "nightly"
    if last_fit_at is not None and now - last_fit_at < WEEKLY_AGE:
        return None
    return "weekly"
