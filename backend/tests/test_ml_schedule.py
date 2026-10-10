"""When EMHASS Lens fits EMHASS's load model by itself (domain/ml_schedule.py)."""

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from emhass_lens.domain.ml_schedule import auto_fit_due

TZ = ZoneInfo("Europe/Tallinn")


def at(hour: int, minute: int = 13, day: int = 10) -> datetime:
    return datetime(2026, 10, day, hour, minute, tzinfo=TZ).astimezone(UTC)


def due(now: datetime, **kw) -> str | None:
    base = {
        "now": now,
        "tz": TZ,
        "auto_fit": "daily",
        "hour": 3,
        "fit_on_fault": True,
        "last_fit_at": at(3, day=9),
        "last_auto": None,
        "last_auto_at": None,
        "fault": None,
    }
    base.update(kw)
    return auto_fit_due(**base)


def test_daily_fits_once_in_the_night_window() -> None:
    assert due(at(2, 59)) is None
    assert due(at(3, 0)) == "nightly"
    assert due(at(5, 59)) == "nightly"
    assert due(at(6, 0)) is None
    assert due(at(14)) is None
    assert due(at(3, 28), last_fit_at=at(3, 14)) is None  # already fitted tonight
    failed = {"reason": "nightly", "fault": False, "ok": False}
    assert due(at(3, 28), last_auto=failed, last_auto_at=at(3, 14)) is None  # one attempt a night
    assert due(at(3, 13), last_fit_at=None) == "nightly"
    assert due(at(23, 13, day=9), hour=23) == "nightly"
    assert due(at(0, 30, day=10), hour=23) == "nightly"  # the window runs past midnight
    assert due(at(0, 30, day=10), hour=23, last_fit_at=at(23, 14, day=9)) is None
    assert due(at(2, 30, day=10), hour=23) is None


def test_weekly_waits_for_a_week_old_model() -> None:
    assert due(at(3), auto_fit="weekly", last_fit_at=at(3, day=4)) is None
    assert due(at(3), auto_fit="weekly", last_fit_at=at(3, day=3)) == "weekly"
    assert due(at(3), auto_fit="weekly", last_fit_at=None) == "weekly"
    assert due(at(3), auto_fit="off") is None


def test_a_fault_fits_at_once_but_not_again_within_six_hours() -> None:
    fault = "it forecasts only 144 of 233 slots (a tuned model)"
    assert due(at(14), fault=fault) == f"the model can't serve the runs: {fault}"
    assert due(at(14), fault=fault, auto_fit="off") is not None
    assert due(at(14), fault=fault, fit_on_fault=False) is None
    tried = {"reason": "x", "fault": True, "ok": False}
    assert due(at(14), fault=fault, last_auto=tried, last_auto_at=at(9)) is None
    assert due(at(16), fault=fault, last_auto=tried, last_auto_at=at(9)) is not None
    nightly = {"reason": "nightly", "fault": False, "ok": True}
    assert due(at(14), fault=fault, last_auto=nightly, last_auto_at=at(9)) is not None
