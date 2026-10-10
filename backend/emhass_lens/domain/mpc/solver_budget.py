"""How long EMHASS's solver may take for one optimisation, from the time left before the slot's publish. Pure.

EMHASS gives HiGHS `lp_solver_timeout` seconds; when it stops at that limit (status user_limit) EMHASS retries a
relaxed problem under the same limit and, if that isn't "Optimal" either, records an error without a message. A
timed-out optimisation can therefore take about twice its limit and yields no plan (run 985: 55 s limit, 91 s, no plan).
So each limit is a share of the time left divided by `RESCUE_FACTOR`, and a live solve that stopped at its limit is
retried once with a looser MIP gap in whatever time is left.
"""

from datetime import datetime, timedelta
from typing import Any

from emhass_lens.core.slots import slot_floor

RESCUE_FACTOR = 2.2  # a timed-out solve plus EMHASS's relaxed retry
RESERVE_S = 10.0  # reading the plan back and storing it
MIN_LIMIT_S = 15
MAX_LIMIT_S = 180  # EMHASS's own default; a manual run mid-slot has a whole quarter
MIN_LEAD_S = 60  # closer to the publish than this: plan for the next quarter's publish instead
LIVE_SHARE = 0.6
ALTERNATIVE_SHARE = 0.15
ALTERNATIVE_MAX_S = 30


def deadline(now: datetime, publish_offset_s: int) -> datetime:
    """When the plan must be ready: the next slot's publish (or the one after, when that is less than a minute
    away)."""
    nxt = slot_floor(now) + timedelta(minutes=15) + timedelta(seconds=publish_offset_s)
    if (nxt - now).total_seconds() < MIN_LEAD_S:
        nxt += timedelta(minutes=15)
    return nxt


def limit_for(now: datetime, until: datetime, share: float, cap: int = MAX_LIMIT_S) -> int | None:
    """Whole seconds of solver time for one optimisation, or None when too little time is left to bother."""
    left = (until - now).total_seconds() - RESERVE_S
    limit = int(left * share / RESCUE_FACTOR)
    if limit < MIN_LIMIT_S:
        return None
    return min(limit, cap)


def alternative_limit(now: datetime, until: datetime) -> int | None:
    """A cost-function comparison step: short, so the live plan keeps most of the time."""
    return limit_for(now, until, ALTERNATIVE_SHARE, cap=ALTERNATIVE_MAX_S)


def http_timeout(limit: int | None, configured_s: float) -> float:
    """The HTTP request has to outlast EMHASS's solve and its relaxed retry."""
    if limit is None:
        return configured_s
    return max(configured_s, limit * 2.5 + 30)


def solve_seconds(last_run: dict[str, Any] | None) -> float | None:
    stages = (last_run or {}).get("stage_times") or {}
    value = stages.get("optim_solve.solve")
    return float(value) if isinstance(value, (int, float)) else None


def timed_out(last_run: dict[str, Any] | None, limit: float | None) -> bool:
    """EMHASS recorded an error without a reason after solving for about the whole limit."""
    if not last_run or last_run.get("status") != "error" or last_run.get("error_message") or not limit:
        return False
    solved = solve_seconds(last_run)
    return solved is not None and solved >= 0.9 * limit


def explain_error(last_run: dict[str, Any] | None, limit: float | None) -> str:
    """Words for EMHASS's 'error' status, which often comes without a message."""
    message = (last_run or {}).get("error_message")
    if message:
        return str(message)
    solved = solve_seconds(last_run)
    if timed_out(last_run, limit):
        return (
            f"EMHASS's solver stopped at its time limit ({limit:g} s) and its relaxed retry found no plan either "
            f"({solved:.0f} s in all)"
        )
    if solved is not None:
        return f"EMHASS reported an error after {solved:.0f} s of solving; it gave no reason"
    return "EMHASS reported an error; it gave no reason"
