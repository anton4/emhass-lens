"""Plan accuracy: which stored plan (or forecast) to compare a past slot with, and error statistics.

Pure functions. A "snapshot" is (id, when it was made); for a slot and a lead time the snapshot in force
is the newest one made at or before `slot_start - lead`. Lead 0 means the plan in force when the slot
came, which is what the inverter followed.
"""

import math
from bisect import bisect_right
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta


def pick_snapshot(
    snapshots: list[tuple[int, datetime]], slots: list[datetime], lead: timedelta
) -> dict[datetime, int | None]:
    """For every slot, the id of the newest snapshot made at or before `slot - lead` (None if none)."""
    ordered = sorted(snapshots, key=lambda s: s[1])
    stamps = [s[1] for s in ordered]
    out: dict[datetime, int | None] = {}
    for slot in slots:
        k = bisect_right(stamps, slot - lead)
        out[slot] = ordered[k - 1][0] if k > 0 else None
    return out


@dataclass(frozen=True)
class Accuracy:
    n: int  # slots with both a planned and a measured value
    coverage: float  # n / slots asked about
    mae: float | None
    bias: float | None  # mean(planned − actual): > 0 means the plan expected more
    rmse: float | None
    mape: float | None  # %, only when asked for and |actual| > floor


def accuracy(
    pairs: Sequence[tuple[float | None, float | None]], *, mape: bool = False, mape_floor: float = 0.0
) -> Accuracy:
    """Error statistics of (planned, actual) pairs; pairs with a None are skipped but count towards coverage."""
    both = [(p, a) for p, a in pairs if p is not None and a is not None]
    n = len(both)
    if n == 0:
        return Accuracy(0, 0.0, None, None, None, None)
    errors = [p - a for p, a in both]
    mae = sum(abs(e) for e in errors) / n
    bias = sum(errors) / n
    rmse = math.sqrt(sum(e * e for e in errors) / n)
    pct = None
    if mape:
        rel = [abs(p - a) / abs(a) for p, a in both if abs(a) > mape_floor]
        pct = 100 * sum(rel) / len(rel) if rel else None
    return Accuracy(n, n / len(pairs), mae, bias, rmse, pct)


def sign_hint(pairs: Sequence[tuple[float | None, float | None]], *, min_n: int = 48) -> bool:
    """True when planned and measured values move clearly against each other (Pearson r < −0.5),
    which almost always means the sensor's sign convention is the reverse of EMHASS's."""
    both = [(p, a) for p, a in pairs if p is not None and a is not None]
    if len(both) < min_n:
        return False
    n = len(both)
    mp = sum(p for p, _ in both) / n
    ma = sum(a for _, a in both) / n
    cov = sum((p - mp) * (a - ma) for p, a in both)
    vp = sum((p - mp) ** 2 for p, _ in both)
    va = sum((a - ma) ** 2 for _, a in both)
    if vp <= 0 or va <= 0:
        return False
    return cov / math.sqrt(vp * va) < -0.5
