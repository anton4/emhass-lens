"""The market session watchdog's checks, as a pure function.

The App's version of the Home Assistant automation "Qilowatt: Session Watchdog": a safety net that shares no logic
with the market controller (`domain/market.py`), so a bug, a stuck run or a refusal there can't disable it. It
looks only at the session bookkeeping, the market source and the EMHASS switch:

1. stale: a session is open, but the source hasn't named a known market (kratt, fusebox) for `stale_after_s`.
   The controller ends such a session after 5 minutes itself; in Live the watchdog ends it when that didn't happen.
2. long_session: a session has been open for `long_session_s`. Reported, never acted on.
3. emhass_off: no session is open, yet the EMHASS switch has been off for `emhass_off_s` with the inverter in
   Force charge or Force discharge. Reported, never acted on.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from emhass_lens.core.clock import iso
from emhass_lens.domain.market import STATES
from emhass_lens.settings.model import MarketWatchdog

UNKNOWN_AGE_S = 999999.0  # the automation's age for an entity that isn't there
FORCED = (STATES["buy"], STATES["sell"])


@dataclass(frozen=True)
class WatchdogInputs:
    app_session: str | None  # the App's own open session (Live): buy | sell
    app_session_since: datetime | None
    select: str | None  # input_select.qilowatt_session_state
    select_changed: datetime | None
    source: str | None  # sensor.qw_source; None when the entity is missing
    source_changed: datetime | None
    enable: str | None  # input_boolean.emhass_automation
    enable_changed: datetime | None
    passive_state: str | None  # input_select.emhass_passive_state


@dataclass(frozen=True)
class Finding:
    kind: str  # stale | long_session | emhass_off
    severity: str  # error | warning
    direction: str | None  # the session's direction (buy | sell), None for emhass_off
    since: datetime | None  # what the age counts from
    age_s: float
    episode: str  # the same while the same situation lasts: a report is sent once per episode
    message: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "severity": self.severity,
            "direction": self.direction,
            "since": iso(self.since),
            "age_s": round(self.age_s),
            "episode": self.episode,
            "message": self.message,
        }


def _age(now: datetime, since: datetime | None) -> float:
    return UNKNOWN_AGE_S if since is None else max(0.0, (now - since).total_seconds())


def _minutes(seconds: float) -> str:
    return "ever" if seconds >= UNKNOWN_AGE_S else f"{int(seconds // 60)} min"


def check(
    i: WatchdogInputs, w: MarketWatchdog, sources: Sequence[str], now: datetime, *, shadow: bool
) -> list[Finding]:
    """What needs attention now. In Shadow the HA automations still run the sessions, so a stale one is a warning
    (they are expected to clear it); in Live it is an error until the watchdog has cleared it."""
    out: list[Finding] = []
    if i.app_session in ("buy", "sell"):
        direction, since = i.app_session, i.app_session_since
    elif i.select in ("buy", "sell"):
        direction, since = i.select, i.select_changed
    else:
        direction, since = None, None

    if direction is not None:
        if i.source not in sources:
            # a missing source counts from the session start, so a vanished sensor still clears the session
            gone_since = i.source_changed if i.source is not None else since
            gone_s = _age(now, gone_since)
            if gone_s > w.stale_after_s:
                source = "missing" if i.source is None else f'"{i.source}"'
                out.append(
                    Finding(
                        "stale",
                        "warning" if shadow else "error",
                        direction,
                        gone_since,
                        gone_s,
                        f"stale:{direction}:{iso(since)}:{iso(gone_since)}",
                        f"{direction} session: qw_source has been {source} for {_minutes(gone_s)}",
                    )
                )
        open_s = _age(now, since)
        if since is not None and open_s >= w.long_session_s:
            out.append(
                Finding(
                    "long_session",
                    "warning",
                    direction,
                    since,
                    open_s,
                    f"long:{direction}:{iso(since)}",
                    f"{direction} session from {i.source or 'an unknown source'} has been open for "
                    f"{open_s / 3600:.1f} h",
                )
            )
    elif i.enable == "off" and i.passive_state in FORCED and i.enable_changed is not None:
        off_s = _age(now, i.enable_changed)
        if off_s >= w.emhass_off_s:
            out.append(
                Finding(
                    "emhass_off",
                    "error",
                    None,
                    i.enable_changed,
                    off_s,
                    f"emhass_off:{iso(i.enable_changed)}",
                    f'the inverter is in "{i.passive_state}" with EMHASS off for {_minutes(off_s)}, '
                    "but no market session is open",
                )
            )
    return out
