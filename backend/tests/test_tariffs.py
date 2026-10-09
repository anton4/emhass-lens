from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from emhass_lens.domain import nordpool
from emhass_lens.domain.tariffs.engine import network_rates, price_slot
from emhass_lens.domain.tariffs.holidays import holiday_name
from emhass_lens.settings.model import Tariff
from tests.fixtures.loader import nordpool as np_fixture
from tests.legacy import legacy_math

TZ = ZoneInfo("Europe/Tallinn")


@pytest.mark.parametrize("day", ["2026-10-08", "2026-10-09", "2026-10-10"])
def test_legacy_compat_reproduces_the_hacs_integration_exactly(day: str) -> None:
    body = np_fixture(day)
    legacy_raw = sorted(legacy_math.price_dict_from_response(body).values(), key=lambda p: p["start"])
    legacy_import = legacy_math.calculated_prices(legacy_raw, "import", legacy_math.LEGACY_DEFAULT_OPTS)
    legacy_export = legacy_math.calculated_prices(legacy_raw, "export", legacy_math.LEGACY_DEFAULT_OPTS)

    parsed = nordpool.parse(body, date.fromisoformat(day), "EE")
    tariff = Tariff()  # defaults = the integration's defaults
    ours = [price_slot(e.eur_mwh, e.start, e.end, tariff, TZ, legacy_compat=True) for e in parsed.entries]

    assert [p.import_price for p in ours] == [p["value"] for p in legacy_import]
    assert [p.export_price for p in ours] == [p["value"] for p in legacy_export]
    assert [p.start.astimezone(TZ).isoformat() for p in ours] == [p["start"] for p in legacy_raw]


def test_full_precision_differs_from_legacy_only_by_spot_rounding() -> None:
    body = np_fixture("2026-10-09")
    parsed = nordpool.parse(body, date(2026, 10, 9), "EE")
    tariff = Tariff()
    for entry in parsed.entries:
        exact = price_slot(entry.eur_mwh, entry.start, entry.end, tariff, TZ)
        legacy = price_slot(entry.eur_mwh, entry.start, entry.end, tariff, TZ, legacy_compat=True)
        # legacy rounds spot to 0.001 €/kWh: at most 0.0005 × 1.24 off on import (+ final 5 dp rounding)
        assert abs(exact.import_price - legacy.import_price) <= 0.0005 * 1.24 + 1e-5
        assert abs(exact.export_price - legacy.export_price) <= 0.0005 + 1e-5


def at(local: str) -> datetime:
    return datetime.fromisoformat(local).replace(tzinfo=TZ).astimezone(UTC)


def period(local: str, **tariff: object) -> tuple[str, str]:
    t = Tariff.model_validate(tariff)
    start = at(local)
    p = price_slot(100.0, start, start + timedelta(minutes=15), t, TZ)
    return p.period, p.reason


def test_day_night_weekend_and_holiday_periods() -> None:
    assert period("2026-10-09T12:00") == ("day", "day")  # Friday
    assert period("2026-10-09T22:00")[0] == "night"
    assert period("2026-10-09T06:45")[0] == "night"
    assert period("2026-10-09T07:00") == ("day", "day")
    assert period("2026-10-10T12:00") == ("night", "weekend")  # Saturday
    assert period("2026-12-24T12:00") == ("night", "holiday: Christmas Eve")


def test_winter_time_basis_shifts_night_window_in_summer() -> None:
    # Summer (EEST): 22:30 wall clock is 21:30 winter time -> still day with standard_time basis
    assert period("2026-07-14T22:30")[0] == "night"
    assert period("2026-07-14T22:30", night_window={"clock_basis": "standard_time"})[0] == "day"
    assert period("2026-07-14T07:30", night_window={"clock_basis": "standard_time"})[0] == "night"
    # Winter: no shift
    assert period("2026-01-14T22:30", night_window={"clock_basis": "standard_time"})[0] == "night"


def test_vork5_winter_peaks() -> None:
    assert period("2026-01-14T10:00", package="vork5") == ("day_peak", "day peak 09–12 / 16–20 (Nov–Mar)")
    assert period("2026-01-17T17:00", package="vork5")[0] == "holiday_peak"  # Saturday
    assert period("2026-07-14T10:00", package="vork5")[0] == "day"  # summer: no peaks
    assert period("2026-01-14T10:00", package="vork4")[0] == "day"  # package without peaks


def test_packages_override_custom_network_rates() -> None:
    rates = network_rates(Tariff(package="vork2"))
    assert (rates.day, rates.night) == (0.0607, 0.0351)
    custom = network_rates(Tariff(package="custom", network={"day": 0.05, "night": 0.02}))  # type: ignore[arg-type]
    assert (custom.day, custom.night) == (0.05, 0.02)


def test_import_price_breakdown_adds_up() -> None:
    start = at("2026-10-09T12:00")
    p = price_slot(87.5, start, start + timedelta(minutes=15), Tariff(package="vork4"), TZ)
    assert p.spot == 0.0875
    assert p.network == 0.0369
    expected = (0.0875 + p.tariff_ex_vat) * 1.24
    assert p.import_price == pytest.approx(expected)
    assert p.vat == pytest.approx(expected - (0.0875 + p.tariff_ex_vat))
    assert p.export_price == pytest.approx(0.0875 - 0.01 - 0.00373)


def _easter(year: int) -> date:
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7  # noqa: E741
    m = (a + 11 * h + 22 * l) // 451
    return date(year, (h + l - 7 * m + 114) // 31, (h + l - 7 * m + 114) % 31 + 1)


@pytest.mark.parametrize("year", range(2025, 2031))
def test_holidays_match_mffr_list(year: int) -> None:
    easter = _easter(year)
    fixed = [(1, 1), (2, 24), (5, 1), (6, 23), (6, 24), (8, 20), (12, 24), (12, 25), (12, 26)]
    mffr = {date(year, m, d) for m, d in fixed} | {easter - timedelta(days=2), easter, easter + timedelta(days=49)}
    ours = {d for d in (date(year, 1, 1) + timedelta(days=i) for i in range(366)) if d.year == year and holiday_name(d)}
    assert ours == mffr
