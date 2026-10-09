"""Which slot EMHASS treats as the first one of a run, and when it's unsafe to submit.

EMHASS builds its forecast grid from "now" at request time, rounded by `method_ts_round`:
- nearest: round to the nearest step (in UTC, half-to-even on an exact tie);
- first:   floor to the step;
- last:    ceil to the step.
The lists we send are mapped onto that grid by position, so element 0 must be the anchor slot.

EMHASS < 0.18.2 also used a floor-rounded grid in one validation step; a run submitted close to a
slot boundary could see the two grids disagree and fail (KeyError: Timestamp not in index). Runs
that would start inside such a window wait until it has passed.
"""

from datetime import UTC, datetime, timedelta

STEP_S = 900


def anchor_slot(submit_at: datetime, method_ts_round: str, step_s: int = STEP_S) -> datetime:
    ts = submit_at.astimezone(UTC).timestamp()
    whole = int(ts) - int(ts) % step_s
    rest = ts - whole
    if method_ts_round == "first":
        start = whole
    elif method_ts_round == "last":
        start = whole if rest == 0 else whole + step_s
    elif method_ts_round == "nearest":
        if rest > step_s / 2:
            start = whole + step_s
        elif rest < step_s / 2:
            start = whole
        else:  # exact tie: half-to-even like pandas
            start = whole if (whole // step_s) % 2 == 0 else whole + step_s
    else:
        raise ValueError(f"unsupported method_ts_round {method_ts_round!r}")
    return datetime.fromtimestamp(start, UTC)


def hazard_boundaries(method_ts_round: str, emhass_version: tuple[int, ...] | None) -> tuple[int, ...]:
    """Seconds into a slot where submitting is risky."""
    boundaries: set[int] = set()
    if method_ts_round == "nearest":
        boundaries.add(STEP_S // 2)  # the rounding flips here
    if emhass_version is None or emhass_version < (0, 18, 2):
        boundaries.update({0, STEP_S})  # older versions also floor in validation
    return tuple(sorted(boundaries))


def hazard_wait(
    submit_at: datetime, method_ts_round: str, emhass_version: tuple[int, ...] | None, guard_s: int
) -> float:
    """Seconds to wait so the submission is at least guard_s away from every risky boundary."""
    if guard_s <= 0:
        return 0.0
    into = submit_at.astimezone(UTC).timestamp() % STEP_S
    for boundary in hazard_boundaries(method_ts_round, emhass_version):
        if boundary - guard_s <= into < boundary + guard_s:
            return boundary + guard_s - into
    return 0.0


def slot_offset(anchor: datetime, current_slot: datetime) -> int:
    """How many slots the anchor lies after the slot that contains now (0 or 1 in practice)."""
    return int((anchor - current_slot) / timedelta(seconds=STEP_S))


def parse_version(text: str | None) -> tuple[int, ...] | None:
    if not text:
        return None
    parts: list[int] = []
    for piece in text.lstrip("v").split("."):
        digits = "".join(ch for ch in piece if ch.isdigit())
        if not digits:
            break
        parts.append(int(digits))
    return tuple(parts) or None
