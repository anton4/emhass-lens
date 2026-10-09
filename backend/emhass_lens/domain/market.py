"""The Qilowatt market controller's decision, as a pure function.

This mirrors the Home Assistant automation "Qilowatt: Master Market Controller" guard for guard. A market command
(Kratt or Fusebox through Qilowatt) arrives as three sensors: the source, the mode (buy-ish or sell-ish) and the
power limit. On every trigger the desired inverter state is derived from the current values and reconciled with
the registers, with three guards against needless writes to the Sofar's EEPROM:

1. Direction-aware hysteresis: `enter_w` gates starting a session and flipping direction, `exit_w` only gates
   continuing in the same direction. A command under the gate while a session is open ends the session.
2. A proportional deadband: max(deadband_w, deadband_pct × |target|).
3. A cooldown between commits, bypassed for session edges, wrong battery rails and big changes. Session ends
   are never throttled.
"""

from dataclasses import asdict, dataclass, field
from typing import Any

from emhass_lens.domain.inverter import Targets, round100
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
    fusebox_sell_helper_w: float | None  # input_number.fusebox_sell_power_helper; None -> -15000
    trigger_kind: str  # qw | soc | reconcile | manual | startup | reconnect | settings | promoted
    trigger_entity: str
    force_end: bool = False  # the kill switch: end the session whatever the command

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

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


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
    helper = int(i.fusebox_sell_helper_w) if i.fusebox_sell_helper_w is not None else -15000
    helper_case = action == "sell" and source == "fusebox" and helper > -14999
    if action == "buy":
        grid = t.buy_cap_w if source == "fusebox" else min(qw_power, t.buy_cap_w)
    elif action == "sell":
        grid = helper if helper_case else -min(qw_power, t.sell_cap_w)
    else:
        grid = 0
    if action == "sell":
        if helper_case:
            feedin, feedin_why = abs(helper), f"the Fusebox sell helper says {helper} W"
        elif pv < t.low_pv_w:
            feedin, feedin_why = t.sell_cap_w, f"PV {pv:.0f} W is below {t.low_pv_w} W: the export maximum"
        else:
            feedin, feedin_why = min(qw_power, t.sell_cap_w), "the commanded power, capped at the export maximum"
    elif action == "end":
        feedin, feedin_why = (
            0,
            "computed but never written at a session end (the automation writes feed-in only while selling)",
        )
    else:
        feedin, feedin_why = qw_power, "the commanded power (not written while buying)"

    cur_grid = -99999.0 if i.cur_grid_w is None else i.cur_grid_w
    cur_bmax = -99999.0 if i.cur_battery_max_w is None else i.cur_battery_max_w
    cur_bmin = -99999.0 if i.cur_battery_min_w is None else i.cur_battery_min_w
    cur_feedin = -99999.0 if i.cur_feedin_w is None else i.cur_feedin_w
    grid_delta = abs(cur_grid - grid)
    rails_wrong = cur_bmax != bmax or cur_bmin != bmin
    since_commit = 99999.0 if i.since_commit_s is None else i.since_commit_s
    eff_deadband = max(float(t.deadband_w), t.deadband_pct * abs(grid))
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
        reasons.append("registers already safe" if not needs_update else "write the safe state (never throttled)")
    elif action in ("buy", "sell"):
        reasons.append(f"grid {cur_grid:.0f} → {grid} W: delta {grid_delta:.0f} W, deadband {eff_deadband:.0f} W")
        if rails_wrong:
            reasons.append(f"battery rails {cur_bmin:.0f}…{cur_bmax:.0f} W must be {bmin}…{bmax} W")
        if cooldown_block:
            reasons.append(f"cooldown: {since_commit:.0f} s since the last write < {t.cooldown_s} s, no bypass: hold")
        elif bypass and since_commit < t.cooldown_s:
            reasons.append(f"cooldown bypassed ({', '.join(bypass_reasons)})")
        needs_update = not cooldown_block and (rails_wrong or grid_delta > eff_deadband)
        if not needs_update and not cooldown_block:
            reasons.append("within the deadband: nothing to write")
    else:
        needs_update = False
    throttle = Throttle(
        grid_delta, eff_deadband, rails_wrong, i.since_commit_s, bypass, bypass_reasons, cooldown_block, reasons
    )

    feedin_deadband = max(float(t.deadband_w), t.deadband_pct * abs(feedin))
    since_feedin = 99999.0 if i.since_feedin_commit_s is None else i.since_feedin_commit_s
    feedin_write = (
        action == "sell"
        and (pv >= t.low_pv_w or is_initial_sell)
        and abs(cur_feedin - feedin) > feedin_deadband
        and (is_initial_sell or since_feedin > t.cooldown_s)
    )

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
    """None means "not judged" (e.g. a cooldown-blocked write leaves the register as it was)."""
    t = d.targets
    write = d.needs_update and t is not None
    return Expected(
        session=d.session_after or "none",
        enable_boolean=d.enable_boolean_after,
        state=t.state if t is not None and d.action != "none" else None,
        grid_power_w=float(t.grid_power_w) if write and t is not None else i.cur_grid_w,
        battery_max_w=float(t.battery_max_w) if write and t is not None else i.cur_battery_max_w,
        battery_min_w=float(t.battery_min_w) if write and t is not None else i.cur_battery_min_w,
        feedin_max_w=float(d.feedin_w) if d.feedin_write and d.feedin_w is not None else i.cur_feedin_w,
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
