"""The Qilowatt market controller's decision, as a pure function.

This mirrors the Home Assistant automation "Qilowatt: Master Market Controller" guard for guard. A market command
(Kratt or Fusebox through Qilowatt) arrives as three sensors: the source, the mode (buy-ish or sell-ish) and the
power limit. On every trigger the desired inverter state is derived from the current values and reconciled with
the registers, with three guards against needless writes to the Sofar's EEPROM:

1. Direction-aware hysteresis: `enter_w` gates starting a session and flipping direction, `exit_w` only gates
   continuing in the same direction. A command under the gate while a session is open ends the session.
2. A proportional deadband: max(deadband_w, deadband_pct × |target|), for a fresh change. A gap of more than
   `deadband_w` that has held for `cooldown_s` (`gap_for_s`, tracked by the service) is written anyway: the
   automation holds it for the rest of the session, and on 2026-10-14 Kratt asked 10600 W and got 9400 W for ten
   minutes. `parity_needs_update` keeps the automation's own call, which shadow mode judges.
3. A cooldown between commits, bypassed for session edges, wrong battery rails and big changes. Session ends
   are never throttled.

One deliberate difference, because every press of the feed-in button is an EEPROM write: the automation sets the
feed-in limit to the commanded power on every sell (on its own cooldown). The meter exports the lower of the grid
target and the feed-in limit, so a limit held below a rising command under-delivers, and one above it only lets out
PV that the battery can't take. Here the limit follows the command only when that can happen: the battery is at or
above `sell_full_soc_pct` (97 %; it still takes ~900 W at 93 %) and the PV beyond the house exceeds the command by
more than the deadband. Otherwise a held limit at or above the command is kept, and a lower one is raised to the sell
cap at once. The automation's value is still computed (`parity_feedin_w`) and shown, and a sell's feed-in isn't compared
in shadow mode.
"""

from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any

from emhass_lens.core.clock import parse_iso
from emhass_lens.domain.inverter import Targets, round100
from emhass_lens.domain.measure import numeric
from emhass_lens.settings.model import InverterLimits, MarketThresholds

LOST = ("unavailable", "unknown", "none")
STATES = {"buy": "Force charge", "sell": "Force discharge", "end": "Self-use battery or PV"}


@dataclass(frozen=True)
class MarketInputs:
    source: str | None  # sensor.qw_source; None when the entity is missing
    mode: str | None  # sensor.qw_mode
    powerlimit_w: float | None  # sensor.qw_powerlimit; None when not numeric
    source_lost_for_s: float | None  # seconds since qw_source last changed; None when unknown
    soc_pct: float | None  # None -> 100 (the automation's | float(100))
    pv_power_w: float | None  # None -> 0
    session: str | None  # "buy" | "sell" | None
    cur_grid_w: float | None  # the passive-mode registers; None -> -99999 (forces an update)
    cur_battery_max_w: float | None
    cur_battery_min_w: float | None
    cur_feedin_w: float | None
    since_commit_s: float | None  # seconds since the passive registers were last written; None -> unknown
    since_feedin_commit_s: float | None
    trigger_kind: str  # qw | soc | reconcile | manual | startup | reconnect | settings | promoted
    trigger_entity: str
    force_end: bool = False  # the kill switch: end the session whatever the command
    load_w: float | None = None  # the house load now; None -> 0 (all PV counts as spare)
    gap_for_s: float | None = None  # seconds the grid target has been more than deadband_w off; None -> new/unknown

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Throttle:
    grid_delta_w: float
    effective_deadband_w: float
    rails_wrong: bool
    since_commit_s: float | None
    cooldown_bypass: bool
    bypass_reasons: list[str]
    cooldown_block: bool
    reasons: list[str]  # the reasoning in words, in order
    gap_for_s: float | None = None
    gap_held: bool = False  # the gap outlasted the cooldown: the deadband is deadband_w, not the proportional one


@dataclass(frozen=True)
class MarketDecision:
    action: str  # buy | sell | end | none
    end_reason: str  # n/a | low_soc | below_gate | source_lost | mode_cleared | forced
    cmd_dir: str  # buy | sell | none
    continuing: bool
    is_initial_sell: bool
    power_gate_w: int
    qw_power_w: int
    source_ok: bool
    source_lost: bool
    bad_powerlimit: bool
    anomaly: bool
    session_after: str | None
    enable_boolean_after: str | None  # "on" after an end, "off" during a session, None when nothing changes
    targets: Targets | None
    feedin_w: int | None
    feedin_write: bool
    feedin_why: str
    needs_update: bool
    throttle: Throttle
    message: str
    notify: str | None
    why: str
    notes: list[str] = field(default_factory=list)
    parity_feedin_w: int | None = None  # what the automation would set the feed-in limit to
    parity_feedin_write: bool = False  # and whether it would write it now
    parity_needs_update: bool = False  # whether the automation would write the passive registers now

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def sell_feedin(
    cmd: int,
    held: float | None,
    soc: float,
    pv: float,
    load: float | None,
    since_feedin_s: float,
    initial: bool,
    t: MarketThresholds,
) -> tuple[int, bool, str]:
    """The feed-in limit during a sell: (limit, write it, why). `cmd` is the commanded export, already capped."""
    house = 0.0 if load is None else load
    spare = pv - house
    deadband = max(float(t.deadband_w), t.deadband_pct * cmd)
    full = t.sell_full_soc_pct
    pv_text = f"PV {pv:.0f} W, house {house:.0f} W" if load is not None else f"PV {pv:.0f} W, house load unknown"
    if soc >= full and spare > cmd + deadband:
        why = (
            f"SOC {soc:g} % ≥ {full:g} % and the PV beyond the house ({spare:.0f} W; {pv_text}) exceeds the command "
            f"by more than {deadband:.0f} W"
        )
        if held is None or held < cmd - 0.5:
            return cmd, True, f"capped at the commanded {cmd} W: {why}"
        if held - cmd > deadband:
            if initial or since_feedin_s >= t.cooldown_s:
                return cmd, True, f"lowered to the commanded {cmd} W: {why}"
            return (
                round(held),
                False,
                f"kept {held:.0f} W for now: cooldown ({since_feedin_s:.0f} s < {t.cooldown_s} s) before lowering it "
                f"to {cmd} W; {why}",
            )
        return round(held), False, f"kept {held:.0f} W: within {deadband:.0f} W above the commanded {cmd} W; {why}"
    if spare <= 0:
        reason = f"no PV to spare ({pv_text})"
    elif soc < full:
        reason = f"the battery takes the spare PV (SOC {soc:g} % < {full:g} %)"
    else:
        reason = (
            f"the PV beyond the house ({spare:.0f} W; {pv_text}) doesn't exceed the command by more than "
            f"{deadband:.0f} W"
        )
    if held is not None and held >= cmd - 0.5:
        return round(held), False, f"kept {held:.0f} W: at least the commanded {cmd} W; {reason}"
    now = "unknown" if held is None else f"{held:.0f} W"
    return (
        t.sell_cap_w,
        True,
        f"raised to the sell cap {t.sell_cap_w} W: {now} is below the commanded {cmd} W; {reason}",
    )


def decide(
    i: MarketInputs, t: MarketThresholds, limits: InverterLimits, *, end_label: str = STATES["end"]
) -> MarketDecision:
    source = i.source if i.source is not None else "unknown"
    mode = i.mode if i.mode is not None else "unknown"
    qw_power = round100(i.powerlimit_w or 0.0)
    soc = 100.0 if i.soc_pct is None else i.soc_pct
    pv = i.pv_power_w or 0.0
    session = i.session if i.session in ("buy", "sell") else None
    reasons: list[str] = []

    source_ok = source in t.sources
    source_lost = source in LOST
    lost_for = 999999.0 if i.source_lost_for_s is None else i.source_lost_for_s
    in_buy, in_sell = mode in t.buy_modes, mode in t.sell_modes
    market_mode = in_buy or in_sell
    bad_powerlimit = source_ok and market_mode and qw_power <= 0
    cmd_dir = "buy" if source_ok and in_buy else "sell" if source_ok and in_sell else "none"
    continuing = cmd_dir != "none" and cmd_dir == session
    gate = t.exit_w if continuing else t.enter_w
    power_ok = qw_power >= gate

    if i.force_end:
        action = "end" if session else "none"
        reasons.append("end requested by hand" if session else "end requested by hand, but no session is open")
    elif source_ok and in_buy:
        action = "buy" if qw_power > 0 and power_ok else ("end" if session else "none")
    elif source_ok and in_sell:
        if soc < t.min_soc:
            action = "end" if session else "none"
        else:
            action = "sell" if qw_power > 0 and power_ok else ("end" if session else "none")
    elif session and source_ok:
        action = "end"
    elif session and source_lost:
        action = "end" if lost_for > t.unavailable_timeout_s else "none"
    elif session:
        action = "end"
    else:
        action = "none"

    if action != "end":
        end_reason = "n/a"
    elif i.force_end:
        end_reason = "forced"
    elif source_ok and in_sell and soc < t.min_soc:
        end_reason = "low_soc"
    elif source_ok and market_mode:
        end_reason = "below_gate"
    elif source_lost:
        end_reason = "source_lost"
    else:
        end_reason = "mode_cleared"
    anomaly = (action == "end" and end_reason in ("low_soc", "source_lost")) or (
        bad_powerlimit and i.trigger_kind == "qw"
    )
    is_initial_sell = action == "sell" and session != "sell"

    if cmd_dir != "none":
        gate_text = f"{'exit' if continuing else 'enter'} gate {gate} W"
        reasons.append(
            f"{source} {mode} {qw_power} W, session {session or 'none'}: "
            + (f"{'continuing' if continuing else 'start or flip'}, {gate_text} {'met' if power_ok else 'not met'}")
        )
    elif session:
        reasons.append(f"session {session}, but {source} {mode} is no market command")
    if action == "end":
        reasons.append(f"end: {end_reason}")
    if bad_powerlimit:
        reasons.append(f"ignored {source} {mode} with powerlimit {qw_power} W")

    state = STATES["buy"] if action == "buy" else STATES["sell"] if action == "sell" else end_label
    bmax, bmin = limits.battery_max_w, limits.battery_min_w
    if action == "buy":
        grid = t.buy_cap_w if source == "fusebox" else min(qw_power, t.buy_cap_w)
    elif action == "sell":
        grid = -min(qw_power, t.sell_cap_w)
    else:
        grid = 0
    # the automation's feed-in: the commanded power while selling (the sell cap when there's no PV)
    if action == "sell":
        parity_feedin = t.sell_cap_w if pv < t.low_pv_w else min(qw_power, t.sell_cap_w)
    elif action == "end":
        parity_feedin = 0
    else:
        parity_feedin = qw_power

    cur_grid = -99999.0 if i.cur_grid_w is None else i.cur_grid_w
    cur_bmax = -99999.0 if i.cur_battery_max_w is None else i.cur_battery_max_w
    cur_bmin = -99999.0 if i.cur_battery_min_w is None else i.cur_battery_min_w
    cur_feedin = -99999.0 if i.cur_feedin_w is None else i.cur_feedin_w
    grid_delta = abs(cur_grid - grid)
    rails_wrong = cur_bmax != bmax or cur_bmin != bmin
    since_commit = 99999.0 if i.since_commit_s is None else i.since_commit_s
    proportional = max(float(t.deadband_w), t.deadband_pct * abs(grid))
    # a gap only the proportional deadband hides is written once it has held for the cooldown
    in_between = action in ("buy", "sell") and t.deadband_w < grid_delta <= proportional
    gap_held = in_between and i.gap_for_s is not None and i.gap_for_s >= t.cooldown_s
    eff_deadband = float(t.deadband_w) if gap_held else proportional
    bypass_reasons: list[str] = []
    if action == "end":
        bypass_reasons.append("session end")
    if session is None and action in ("buy", "sell"):
        bypass_reasons.append("session start")
    if session is not None and cmd_dir != session and action in ("buy", "sell"):
        bypass_reasons.append("direction change")
    if grid_delta >= t.big_change_w:
        bypass_reasons.append(f"change {grid_delta:.0f} W ≥ {t.big_change_w} W")
    if rails_wrong:
        bypass_reasons.append("battery rails wrong")
    bypass = action == "end" or session is None or cmd_dir != session or grid_delta >= t.big_change_w or rails_wrong
    cooldown_block = since_commit < t.cooldown_s and not bypass
    if action == "end":
        needs_update = grid_delta > 0 or rails_wrong
        parity_update = needs_update
        reasons.append("registers already safe" if not needs_update else "write the safe state (never throttled)")
    elif action in ("buy", "sell"):
        reasons.append(f"grid {cur_grid:.0f} → {grid} W: delta {grid_delta:.0f} W, deadband {proportional:.0f} W")
        if in_between:
            held = i.gap_for_s or 0.0
            reasons.append(
                f"gap held {held:.0f} s ≥ {t.cooldown_s} s: deadband {t.deadband_w} W"
                if gap_held
                else f"gap held {held:.0f} s < {t.cooldown_s} s: written at {t.cooldown_s} s if it stays"
            )
        if rails_wrong:
            reasons.append(f"battery rails {cur_bmin:.0f}…{cur_bmax:.0f} W must be {bmin}…{bmax} W")
        if cooldown_block:
            reasons.append(f"cooldown: {since_commit:.0f} s since the last write < {t.cooldown_s} s, no bypass: hold")
        elif bypass and since_commit < t.cooldown_s:
            reasons.append(f"cooldown bypassed ({', '.join(bypass_reasons)})")
        needs_update = not cooldown_block and (rails_wrong or grid_delta > eff_deadband)
        parity_update = not cooldown_block and (rails_wrong or grid_delta > proportional)
        if not needs_update and not cooldown_block:
            reasons.append("within the deadband: nothing to write")
    else:
        needs_update = parity_update = False
    throttle = Throttle(
        grid_delta,
        eff_deadband,
        rails_wrong,
        i.since_commit_s,
        bypass,
        bypass_reasons,
        cooldown_block,
        reasons,
        gap_for_s=i.gap_for_s,
        gap_held=gap_held,
    )

    parity_deadband = max(float(t.deadband_w), t.deadband_pct * abs(parity_feedin))
    since_feedin = 99999.0 if i.since_feedin_commit_s is None else i.since_feedin_commit_s
    parity_feedin_write = (
        action == "sell"
        and (pv >= t.low_pv_w or is_initial_sell)
        and abs(cur_feedin - parity_feedin) > parity_deadband
        and (is_initial_sell or since_feedin > t.cooldown_s)
    )
    if action == "sell":
        feedin, feedin_write, feedin_why = sell_feedin(
            min(qw_power, t.sell_cap_w), i.cur_feedin_w, soc, pv, i.load_w, since_feedin, is_initial_sell, t
        )
    elif action == "end":
        feedin, feedin_write = 0, False
        feedin_why = "computed but never written at a session end (the automation writes feed-in only while selling)"
    else:
        feedin, feedin_write = qw_power, False
        feedin_why = "the commanded power (not written while buying)"

    if action == "end":
        message = (
            f"Qilowatt safeguard: session ended ({end_reason}). source={source} mode={mode} soc={soc:g}% "
            f"powerlimit={qw_power}W. Control returned to EMHASS."
        )
    elif bad_powerlimit:
        message = f"Qilowatt safeguard: ignored {source} {mode} with powerlimit {qw_power}W."
    else:
        message = f"{source.capitalize()} {action} {qw_power}W"
    notify = message if anomaly else None
    session_after = None if action == "end" else action if action in ("buy", "sell") else session
    enable_after = "on" if action == "end" else "off" if action in ("buy", "sell") else None
    targets = None if action == "none" else Targets(state, grid, bmax, bmin)
    why = f"{source} {mode} {qw_power} W, session {session or 'none'} → {action}" + (
        f" ({end_reason})" if action == "end" else ""
    )
    return MarketDecision(
        action,
        end_reason,
        cmd_dir,
        continuing,
        is_initial_sell,
        gate,
        qw_power,
        source_ok,
        source_lost,
        bad_powerlimit,
        anomaly,
        session_after,
        enable_after,
        targets,
        feedin if action != "none" else None,
        feedin_write,
        feedin_why,
        needs_update,
        throttle,
        message,
        notify,
        why,
        parity_feedin_w=parity_feedin if action != "none" else None,
        parity_feedin_write=parity_feedin_write,
        parity_needs_update=parity_update,
    )


# --- shadow mode: what Home Assistant should show after the automation handled the same inputs -----------------


@dataclass(frozen=True)
class Expected:
    session: str  # buy | sell | none
    enable_boolean: str | None
    state: str | None
    grid_power_w: float | None
    battery_max_w: float | None
    battery_min_w: float | None
    feedin_max_w: float | None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def expected_after(d: MarketDecision, i: MarketInputs) -> Expected:
    """None means "not judged" (e.g. a cooldown-blocked write leaves the register as it was). A sell's feed-in limit
    isn't judged: EMHASS Lens deliberately writes it less often than the automation. A held gap that EMHASS Lens
    writes the automation leaves, so the registers are judged by the automation's own call."""
    t = d.targets
    write = d.parity_needs_update and t is not None
    return Expected(
        session=d.session_after or "none",
        enable_boolean=d.enable_boolean_after,
        state=t.state if t is not None and d.action != "none" else None,
        grid_power_w=float(t.grid_power_w) if write and t is not None else i.cur_grid_w,
        battery_max_w=float(t.battery_max_w) if write and t is not None else i.cur_battery_max_w,
        battery_min_w=float(t.battery_min_w) if write and t is not None else i.cur_battery_min_w,
        feedin_max_w=None if d.action == "sell" else i.cur_feedin_w,
    )


def compare_expected(e: Expected, observed: dict[str, Any]) -> dict[str, Any]:
    rows = []
    for name, want in e.as_dict().items():
        if want is None:
            continue
        got = observed.get(name)
        if isinstance(want, str):
            same = got == want
        else:
            same = got is not None and abs(float(got) - want) < 0.5
        rows.append({"field": name, "decided": want, "observed": got, "same": same})
    return {"agree": all(r["same"] for r in rows), "fields": rows}


# --- the commands over time, for the Plan page's Power chart -----------------------------------------------------


@dataclass(frozen=True)
class CommandSpan:
    start: datetime
    end: datetime
    direction: str  # buy | sell
    source: str
    mode: str
    power_w: int
    open: bool  # still on at the end of the window


def _changes(states: list[dict[str, Any]]) -> list[tuple[datetime, Any]]:
    """(when, state) from recorder history items, oldest first; a state holds until the next one."""
    out: list[tuple[datetime, Any]] = []
    for s in states:
        stamp = parse_iso(s.get("last_changed") or s.get("last_updated"))
        if stamp is not None:
            out.append((stamp, s.get("state")))
    out.sort(key=lambda c: c[0])
    return out


class _Cursor:
    """The state in force at moments asked for in order."""

    def __init__(self, changes: list[tuple[datetime, Any]]) -> None:
        self.changes = changes
        self.i = 0
        self.value: Any = None

    def at(self, t: datetime) -> Any:
        while self.i < len(self.changes) and self.changes[self.i][0] <= t:
            self.value = self.changes[self.i][1]
            self.i += 1
        return self.value


def command_spans(
    source: list[dict[str, Any]],
    mode: list[dict[str, Any]],
    powerlimit: list[dict[str, Any]],
    t: MarketThresholds,
    start: datetime,
    end: datetime,
) -> list[CommandSpan]:
    """The market commands in [start, end) from the recorder history of the source, mode and power-limit sensors
    (each list's first item may be older than `start`: the state in force then). A command is what `decide` reads
    as one: a known source with a buy or sell mode and a power above zero (rounded to 100 W). A span ends when the
    direction, source, mode or power changes; whether a session followed (the gates, the SoC floor) isn't judged."""
    streams = [_changes(source), _changes(mode), _changes(powerlimit)]
    moments = sorted({start, *(stamp for c in streams for stamp, _ in c if start < stamp < end)})
    src_at, mode_at, power_at = (_Cursor(c) for c in streams)
    spans: list[CommandSpan] = []
    current: tuple[str, str, str, int] | None = None
    since = start
    for moment in [*moments, end]:
        command: tuple[str, str, str, int] | None = None
        if moment < end:
            src, md = src_at.at(moment), mode_at.at(moment)
            power = round100(numeric(power_at.at(moment)) or 0.0)
            if src in t.sources and power > 0:
                direction = "buy" if md in t.buy_modes else "sell" if md in t.sell_modes else None
                if direction:
                    command = (direction, str(src), str(md), power)
        if command == current and moment < end:
            continue
        if current is not None:
            direction, src, md, power = current
            spans.append(CommandSpan(since, moment, direction, src, md, power, open=moment >= end))
        current, since = command, moment
    return spans
