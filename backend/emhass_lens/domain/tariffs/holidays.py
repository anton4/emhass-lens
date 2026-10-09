"""Estonian public holidays (rest days get the night/weekend network rate)."""

from datetime import date
from functools import cache

import holidays as holidays_lib


@cache
def _calendar(year: int) -> dict[date, str]:
    return dict(holidays_lib.country_holidays("EE", years=year, language="en_US").items())


def holiday_name(day: date) -> str | None:
    return _calendar(day.year).get(day)
