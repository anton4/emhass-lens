"""Compare the App's priced slots with a Home Assistant price sensor (a Nord Pool template with fees and
VAT): slot by slot, with a worded explanation when the difference is a constant per tariff period, which
almost always means a different network package or fee set. Pure functions."""

from dataclasses import dataclass
from datetime import datetime
from statistics import median
from typing import Any

from emhass_lens.core.clock import iso, parse_iso
from emhass_lens.domain.tariffs.engine import SlotPrice, network_rates
from emhass_lens.domain.tariffs.packages import PACKAGES
from emhass_lens.settings.model import Tariff

MAX_LISTED = 12
RATE_MATCH = 1e-4  # €/kWh, when a delta points at a known Elektrilevi rate


@dataclass(frozen=True)
class Interval:
    start: datetime
    end: datetime
    value: float


def sensor_intervals(attributes: dict[str, Any] | None) -> list[Interval]:
    """{start, end, value} items from raw_all, else raw_today + raw_tomorrow; sorted, one per start."""
    attrs = attributes or {}
    items = attrs.get("raw_all")
    if not isinstance(items, list):
        items = list(attrs.get("raw_today") or []) + list(attrs.get("raw_tomorrow") or [])
    out: dict[datetime, Interval] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        value = item.get("value")
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            continue
        try:
            start, end = parse_iso(str(item.get("start"))), parse_iso(str(item.get("end")))
        except ValueError:
            continue
        if start is None or end is None or end <= start:
            continue
        out[start] = Interval(start, end, float(value))
    return [out[k] for k in sorted(out)]


def compare(
    name: str,
    intervals: list[Interval],
    ours: list[SlotPrice],
    field: str,
    tolerance: float,
    *,
    spot_decimals: int | None = None,
    vat_factor: float = 1.0,
) -> dict[str, Any]:
    """A parity section: every App slot inside a sensor interval against that interval's value. Forecast
    slots are skipped (the sensor only knows published prices); sensor intervals the App has no slot for
    are counted. `spot_decimals`: the sensor's Nord Pool source rounds the spot price (the HA Nord Pool
    integration to 3 decimals by default), so ours is compared with the spot rounded the same way; the import
    price carries that rounding times the VAT factor."""
    factor = vat_factor if field == "import_price" else 1.0
    by_start = sorted(ours, key=lambda s: s.start)
    diffs: list[dict[str, Any]] = []
    deltas: dict[str, list[float]] = {}
    compared = skipped = without_ours = 0
    i = 0
    for interval in intervals:
        while i < len(by_start) and by_start[i].start < interval.start:
            i += 1
        j = i
        found = False
        while j < len(by_start) and by_start[j].start < interval.end:
            slot = by_start[j]
            j += 1
            found = True
            if slot.is_forecast:
                skipped += 1
                continue
            mine = float(getattr(slot, field))
            if spot_decimals is not None:
                mine += (round(slot.spot, spot_decimals) - slot.spot) * factor
            compared += 1
            delta = mine - interval.value
            if abs(delta) > tolerance:
                deltas.setdefault(slot.period, []).append(delta)
                diffs.append(
                    {
                        "i": compared - 1,
                        "slot": iso(slot.start),
                        "ours": round(mine, 6),
                        "legacy": round(interval.value, 6),
                        "delta": round(delta, 6),
                    }
                )
        if not found:
            without_ours += 1
    return {
        "name": name,
        "theirs_label": name,
        "ours_len": compared,
        "legacy_len": len(intervals),
        "compared": compared,
        "equal": compared - len(diffs),
        "different": len(diffs),
        "examples": diffs[:MAX_LISTED],
        "skipped_forecast": skipped,
        "legacy_slots_without_ours": without_ours,
        "period_deltas": {period: round(median(values), 6) for period, values in deltas.items()},
        "delta_spread": {period: round(max(values) - min(values), 6) for period, values in deltas.items()},
        "ok": not diffs and compared > 0,
        "spot_decimals": spot_decimals,
    }


def _cents(value: float) -> str:
    return f"{abs(value) * 100:.2f} c"


def explain(section: dict[str, Any], tariff: Tariff, field: str, tolerance: float) -> str | None:
    """Words for a difference that is constant per tariff period; names the Elektrilevi package when the
    constant matches one. None when the differences vary (nothing constant to point at)."""
    deltas: dict[str, float] = section.get("period_deltas") or {}
    spread: dict[str, float] = section.get("delta_spread") or {}
    if not deltas:
        return None
    if any(spread.get(period, 0) > 2 * tolerance for period in deltas):
        return None
    if (section.get("different") or 0) < max(2, (section.get("compared") or 0) // 10):
        return None  # a handful of odd slots isn't a systematic difference
    parts = [
        f"{period} slots are {_cents(d)} {'higher' if d > 0 else 'lower'} in EMHASS Lens"
        for period, d in sorted(deltas.items())
    ]
    text = ", ".join(parts)
    if field == "export_price":
        return (
            f"{text}: a constant difference, so the sensor uses other export fees (ours: margin "
            f"{tariff.export_margin * 100:.2f} c + balancing {tariff.export_balancing * 100:.2f} c)"
        )
    vat = 1 + tariff.vat_pct / 100
    ours = network_rates(tariff)
    our_rate = _by_period(ours.day, ours.night, ours.day_peak, ours.holiday_peak)
    matches: list[str] = []
    for package in PACKAGES.values():
        theirs = _by_period(package.day, package.night, package.day_peak, package.holiday_peak)
        if all(abs((our_rate[p] - theirs[p]) * vat - d) <= RATE_MATCH * vat + tolerance for p, d in deltas.items()):
            matches.append(f"{package.label} ({package.day * 100:.2f} / {package.night * 100:.2f} c)")
    if matches and tariff.package in PACKAGES and PACKAGES[tariff.package].label in matches[0]:
        matches = []  # the same package as ours: the constant must be something else
    if matches:
        mine = PACKAGES[tariff.package].label if tariff.package in PACKAGES else "custom rates"
        return (
            f"{text}: the sensor uses {' or '.join(matches)} network rates where EMHASS Lens uses {mine} "
            f"({our_rate['day'] * 100:.2f} / {our_rate['night'] * 100:.2f} c)"
        )
    return (
        f"{text}: a constant difference per period, so the sensor's network rates or fees differ from "
        "Settings → Prices → Tariff"
    )


def _by_period(day: float, night: float, day_peak: float | None, holiday_peak: float | None) -> dict[str, float]:
    return {"day": day, "night": night, "day_peak": day_peak or day, "holiday_peak": holiday_peak or night}
