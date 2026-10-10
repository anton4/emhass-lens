"""EV charger control from the EMHASS plan and from excess solar, as pure decision functions.

This mirrors the Home Assistant automation "EV Charging: Combined EMHASS & Excess Solar (Modbus)" branch for
branch, so EMHASS Lens can run it in dry run and compare, decision by decision, with what the automation did:

- the target-SoC stop: when the car's SoC has been at or above the target for a while, stop charging, set the
  current limit to 0 A and put the target back to 100 %;
- EMHASS mode: follow the plan's P_deferrable0 (start, adjust the current, pause);
- Excess Solar mode: follow the PV surplus, with a stale-PV guard.

The charger's raw state: 0 unplugged, 1/2/5 plugged in or paused, 4 charging. Currents are whole amps.
"""

from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from typing import Any

from emhass_lens.settings.model import ChargerLimits

PLUGGED = (1, 2, 5)
CHARGING = 4
DRAWING = (4, 5)  # states in which the commanded current counts as the charger's own load

LABELS = {
    "soc_limit": "Target SoC reached: stop charging",
    "emhass_adjust": "EMHASS: adjust the current",
    "emhass_pause": "EMHASS: pause charging",
    "emhass_start": "EMHASS: start charging",
    "solar_start": "Excess solar: start charging",
    "solar_adjust": "Excess solar: adjust the current",
    "solar_pause": "Excess solar: pause charging",
    "none": "Nothing to do",
}
ACTIONS = {
    "soc_limit": "stop_soc",
    "emhass_adjust": "set_current",
    "emhass_pause": "pause",
    "emhass_start": "start",
    "solar_start": "start",
    "solar_adjust": "set_current",
    "solar_pause": "pause",
    "none": "none",
}
SOC_MESSAGE = "EV Target SoC reached. Charging disabled and mode set to Manual."


@dataclass(frozen=True)
class ChargerInputs:
    charge_mode: str | None  # input_select.ev_charge_mode
    state_raw: int  # charging state | int(-1)
    current_limit_a: float  # the charger's current limit | float(0)
    soc: float  # the car's usable battery level | float(0)
    target_soc: float | None  # input_number.ev_target_soc; None when it can't be read
    p_deferrable0_w: float | None  # the plan's EV power for this slot; None when unknown
    solar_limit_a: int  # input_number.ev_max_solar_current | int(16)
    pv_actual_w: float
    pv_actual_updated: datetime | None
    pv_potential_w: float
    pv_potential_updated: datetime | None
    house_load_w: float

    def as_dict(self) -> dict[str, Any]:
        out = asdict(self)
        for key in ("pv_actual_updated", "pv_potential_updated"):
            out[key] = self.__dict__[key].isoformat() if self.__dict__[key] is not None else None
        return out


@dataclass(frozen=True)
class Derived:
    pv_power_w: float
    pv_source: str  # "actual" | "potential"
    pv_age_s: float  # 9999 when the chosen PV sensor has no timestamp
    charger_commanded_w: float
    other_load_w: float
    solar_target_a: int
    emhass_current_a: int | None


def emhass_charger_current(p_def_w: float, solar_limit_a: int, limits: ChargerLimits) -> int:
    """The automation's `[p_def / 3 / 230 | round(0), 6] | max` then `| min(solar_limit) | round(0)`: Jinja rounds
    the 230 (a no-op), so the current is p/690 clamped to [6, solar limit] and rounded half to even."""
    value = max(p_def_w / limits.w_per_amp, float(limits.min_current_a))
    return round(min(value, float(solar_limit_a)))


def solar_amps(surplus_w: float, solar_limit_a: int, limits: ChargerLimits) -> int:
    """The Excess Solar current for a PV surplus: whole amps rounded down, 0 below the minimum, capped by the
    maximum-current helper. Shared by the controller and the PV reservation sent to EMHASS."""
    target = int(surplus_w // limits.w_per_amp)
    if target < limits.min_current_a:
        return 0
    return min(target, solar_limit_a)


def derive(i: ChargerInputs, now: datetime, limits: ChargerLimits) -> Derived:
    if i.pv_potential_w - i.pv_actual_w > limits.pv_potential_gap_w:
        pv, source, stamp = i.pv_potential_w, "potential", i.pv_potential_updated
    else:
        pv, source, stamp = i.pv_actual_w, "actual", i.pv_actual_updated
    age = (now - stamp).total_seconds() if stamp is not None else 9999.0
    commanded = i.current_limit_a * limits.w_per_amp if i.state_raw in DRAWING else 0.0
    other = max(i.house_load_w - commanded, 0.0)
    target = int((pv - other) // limits.w_per_amp)
    if target > i.current_limit_a and age >= limits.pv_stale_s:
        target = int(i.current_limit_a)  # don't raise the current on PV data that stopped updating
    target = solar_amps(target * limits.w_per_amp, i.solar_limit_a, limits)
    emhass = (
        emhass_charger_current(i.p_deferrable0_w, i.solar_limit_a, limits) if i.p_deferrable0_w is not None else None
    )
    return Derived(pv, source, age, commanded, other, target, emhass)


# --- the target-SoC stop (the automation's template trigger with `for: 5 minutes`) --------------------------------


@dataclass(frozen=True)
class SocTracker:
    since: datetime | None = None  # when the SoC was first seen at or above the target
    fired: bool = False  # the stop already happened for this stretch (an HA trigger fires once per edge)

    def as_dict(self, for_s: int) -> dict[str, Any]:
        due = soc_stop_at(self, for_s)
        return {
            "since": self.since.isoformat() if self.since else None,
            "fired": self.fired,
            "due_at": due.isoformat() if due else None,
        }


def soc_reached(i: ChargerInputs) -> bool:
    """`soc | float(0) >= target | float(0)`: an unreadable target counts as 0, like in the automation."""
    return i.soc >= (i.target_soc if i.target_soc is not None else 0.0)


def track_soc(t: SocTracker, i: ChargerInputs, now: datetime) -> SocTracker:
    if not soc_reached(i):
        return SocTracker()
    return SocTracker(since=t.since or now, fired=t.fired)


def soc_stop_due(t: SocTracker, now: datetime, for_s: int) -> bool:
    return t.since is not None and not t.fired and (now - t.since).total_seconds() >= for_s


def soc_stop_at(t: SocTracker, for_s: int) -> datetime | None:
    return t.since + timedelta(seconds=for_s) if t.since is not None and not t.fired else None


# --- the decision ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ChargerDecision:
    rule: (
        str  # soc_limit | emhass_adjust | emhass_pause | emhass_start | solar_start | solar_adjust | solar_pause | none
    )
    action: str  # stop_soc | set_current | start | pause | none
    label: str
    why: str
    target_current_a: int | None
    notify: str | None
    derived: Derived
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def decide(
    i: ChargerInputs,
    now: datetime,
    limits: ChargerLimits,
    soc_due: bool,
    *,
    emhass_option: str = "EMHASS",
    solar_option: str = "Excess Solar",
) -> ChargerDecision:
    d = derive(i, now, limits)
    target_soc = i.target_soc if i.target_soc is not None else 100.0  # the mode gates use `| float(100)`

    def make(rule: str, why: str, current: int | None, notify: str | None) -> ChargerDecision:
        return ChargerDecision(rule, ACTIONS[rule], LABELS[rule], why, current, notify, d)

    def none(why: str) -> ChargerDecision:
        return make("none", why, None, None)

    if soc_due:
        minutes = limits.soc_for_s // 60
        why = f"the car's SoC {i.soc:.0f} % has been at or above the target {target_soc:.0f} % for {minutes} min"
        return make("soc_limit", why, 0, SOC_MESSAGE)
    if i.charge_mode not in (emhass_option, solar_option):
        return none(f"charge mode is {i.charge_mode!r}")
    if i.state_raw < 0:
        return none("the charger state can't be read")
    if i.state_raw == 0:
        return none("the car isn't plugged in (state 0)")
    if i.soc >= target_soc:
        return none(f"the car's SoC {i.soc:.0f} % is at the target {target_soc:.0f} %")
    limit = int(i.current_limit_a)

    if i.charge_mode == emhass_option:
        p, cur = i.p_deferrable0_w, d.emhass_current_a
        if p is None or cur is None:
            return none("the plan's EV power (p_deferrable0) is unknown")
        if i.state_raw == CHARGING:
            if p > 1:
                if cur != limit:
                    return make("emhass_adjust", f"charging at {limit} A, the plan asks {p:.0f} W = {cur} A", cur, None)
                return none(f"already charging at the planned {cur} A ({p:.0f} W)")
            if p < 1:
                return make(
                    "emhass_pause",
                    f"charging at {limit} A, but the plan asks {p:.0f} W",
                    0,
                    "EV paused charging (EMHASS)",
                )
            return none("the plan asks exactly 1 W, which neither starts nor pauses")
        if i.state_raw in PLUGGED:
            if p > 1:
                why = f"plugged in (state {i.state_raw}), the plan asks {p:.0f} W = {cur} A"
                return make("emhass_start", why, cur, f"EMHASS started EV at {cur}A")
            return none(f"plugged in (state {i.state_raw}), the plan asks {p:.0f} W")
        return none(f"charger state {i.state_raw} is neither charging nor plugged in")

    t = d.solar_target_a
    solar = f"{d.pv_power_w:.0f} W PV ({d.pv_source}) minus {d.other_load_w:.0f} W other load"
    if i.state_raw in PLUGGED:
        if t >= limits.min_current_a:
            return make(
                "solar_start", f"plugged in, {solar} allows {t} A", t, f"Excess Solar started/resumed EV at {t}A"
            )
        return none(f"plugged in, but {solar} is below {limits.min_current_a} A")
    if i.state_raw == CHARGING:
        if t >= limits.min_current_a:
            if t != limit:
                return make("solar_adjust", f"charging at {limit} A, {solar} allows {t} A", t, None)
            return none(f"already charging at {t} A from excess solar")
        if t == 0:
            why = f"charging at {limit} A, but {solar} is below {limits.min_current_a} A"
            return make("solar_pause", why, 0, "EV paused charging (Not enough excess solar)")
        return none(f"charging at {limit} A, excess solar allows {t} A")
    return none(f"charger state {i.state_raw} is neither charging nor plugged in")


# --- what the charger shows afterwards ------------------------------------------------------------------------


@dataclass(frozen=True)
class ChargerObserved:
    current_limit_a: float | None
    state_raw: int | None
    target_soc: float | None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def compare(decision: ChargerDecision, observed: ChargerObserved) -> dict[str, Any]:
    """Field-by-field agreement between a decision and what the charger entities show. The charging state is
    reported but not judged: the charger takes its time to start, and the automation doesn't wait for it either."""
    rows = []
    if decision.target_current_a is not None:
        got = observed.current_limit_a
        same = got is not None and abs(got - decision.target_current_a) < 0.5
        rows.append({"field": "current_limit_a", "decided": decision.target_current_a, "observed": got, "same": same})
    if decision.action == "stop_soc":
        got = observed.target_soc
        rows.append(
            {"field": "target_soc", "decided": 100, "observed": got, "same": got is not None and abs(got - 100) < 0.5}
        )
    return {"agree": all(r["same"] for r in rows), "fields": rows, "charging_state": observed.state_raw}


def describe(decision: ChargerDecision) -> str:
    if decision.action == "none":
        return f"nothing to do ({decision.why})"
    amps = decision.target_current_a
    what = {
        "stop_soc": "press stop, limit 0 A, target SoC back to 100 %",
        "start": f"press start, limit {amps} A",
        "set_current": f"limit {amps} A",
        "pause": "limit 0 A",
    }[decision.action]
    return f"'{decision.label}' ({decision.rule}): {what}"
