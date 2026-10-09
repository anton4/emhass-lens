"""Bidding zones and their local time zones (tariffs and day boundaries follow local time)."""

from zoneinfo import ZoneInfo

AREA_TZ = {"EE": "Europe/Tallinn", "FI": "Europe/Helsinki", "LV": "Europe/Riga", "LT": "Europe/Vilnius"}


def area_zone(area: str) -> ZoneInfo:
    return ZoneInfo(AREA_TZ.get(area, "Europe/Tallinn"))
