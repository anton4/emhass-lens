"""Compares EMHASS's effective configuration (GET /get-config) with what EMHASS Lens relies on."""

from dataclasses import asdict, dataclass
from typing import Any

from emhass_lens.domain.mpc import export_limit
from emhass_lens.domain.mpc.anchor import parse_version
from emhass_lens.domain.mpc.payload import P10_VERSION, derive
from emhass_lens.settings.model import Settings

MIN_VERSION = (0, 17, 9)  # GET /api/v1/plan
RACE_FIXED_VERSION = (0, 18, 2)
RECOMMENDED_VERSION = (0, 18, 5)  # DST-safe naive-MPC horizon, Optimal_Inaccurate counts as ok


@dataclass(frozen=True)
class Check:
    key: str
    title: str
    status: str  # ok | warning | error | info
    expected: str
    actual: str
    explanation: str

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def run_checks(
    config: dict[str, Any] | None, version: str | None, settings: Settings, ha_time_zone: str | None
) -> list[Check]:
    checks: list[Check] = []
    ver = parse_version(version)
    if ver is None:
        checks.append(
            Check(
                "version",
                "EMHASS version",
                "warning",
                "≥ 0.17.9",
                "unknown",
                "Couldn't read the version from /healthz; features are assumed to be missing.",
            )
        )
    elif ver < MIN_VERSION:
        checks.append(
            Check(
                "version",
                "EMHASS version",
                "error",
                "≥ 0.17.9",
                version or "?",
                "EMHASS Lens reads the plan from GET /api/v1/plan, added in 0.17.9. Update EMHASS.",
            )
        )
    elif ver < RACE_FIXED_VERSION:
        checks.append(
            Check(
                "version",
                "EMHASS version",
                "warning",
                "≥ 0.18.2",
                version or "?",
                "Older versions can fail when a run starts near a slot boundary; runs wait out those "
                "windows (Settings → EMHASS → Grid-boundary guard).",
            )
        )
    elif ver < RECOMMENDED_VERSION:
        checks.append(
            Check(
                "version",
                "EMHASS version",
                "info",
                "≥ 0.18.5 recommended",
                version or "?",
                "Works. 0.18.4 takes the P10 PV estimate EMHASS Lens sends (Settings → PV forecast); 0.18.5 keeps "
                "the MPC horizon and the forecasts right across DST changes and reports Optimal_Inaccurate solutions "
                "as ok instead of error.",
            )
        )
    else:
        checks.append(Check("version", "EMHASS version", "ok", "≥ 0.18.5", version or "?", "Supported."))

    if not config:
        checks.append(
            Check(
                "config",
                "EMHASS configuration",
                "warning",
                "readable",
                "unavailable",
                "GET /get-config failed; the other checks were skipped.",
            )
        )
        return checks

    def get(key: str) -> Any:
        return config.get(key)

    threshold = settings.emhass.mpc.no_export_at_or_below
    if threshold is not None:
        why_not = export_limit.blocker(config, ver)
        checks.append(
            Check(
                "no_export",
                "No export at or below",
                "ok" if why_not is None else "warning",
                "EMHASS ≥ 0.16, compute_curtailment true",
                f"EMHASS {version or '?'}, compute_curtailment {get('compute_curtailment')}",
                f"Each run sends maximum_power_to_grid with 0 W in slots whose export price is at or below "
                f"{threshold} €/kWh (Settings → EMHASS → MPC)."
                if why_not is None
                else f'The plan ignores "No export at or below {threshold} €/kWh": {why_not}. Turn '
                "compute_curtailment on in EMHASS, or clear the setting.",
            )
        )

    step = get("optimization_time_step")
    checks.append(
        _check(
            "optimization_time_step",
            "Optimization time step",
            step in (15, "15"),
            "15",
            step,
            "Prices and plans are in 15-minute slots; EMHASS must use the same step.",
            "error",
        )
    )

    rounding = get("method_ts_round")
    checks.append(
        _check(
            "method_ts_round",
            "Start time rounding",
            rounding in ("nearest", "first"),
            "nearest or first",
            rounding,
            "EMHASS Lens computes which slot EMHASS starts from with this rule; 'last' would start in the future.",
            "error",
        )
    )

    publishing = settings.emhass.mode == "live" and settings.emhass.publish.enabled
    continual = get("continual_publish")
    checks.append(
        _check(
            "continual_publish",
            "Continual publish",
            not (publishing and continual is True),
            "false",
            continual,
            "EMHASS Lens publishes at the start of each slot. With continual publish on as well, EMHASS also "
            "republishes every minute (and switches to the next slot about 8 minutes early with 'nearest').",
            "warning",
        )
    )

    tz = get("time_zone")
    if ha_time_zone and tz:  # EMHASS often takes its time zone from secrets and doesn't report it here
        checks.append(
            _check(
                "time_zone",
                "Time zone",
                tz == ha_time_zone,
                ha_time_zone,
                tz,
                "EMHASS and Home Assistant should agree on local time, or day/night tariffs shift.",
                "warning",
            )
        )

    var_model = settings.emhass.ml.var_model
    sensor_load = get("sensor_power_load_no_var_loads")
    checks.append(
        _check(
            "sensor_power_load_no_var_loads",
            "Load sensor",
            sensor_load == var_model,
            var_model,
            sensor_load,
            "The ML load forecast is trained on Settings → EMHASS → ML → Load sensor; EMHASS's own load sensor "
            "setting usually matches it.",
            "info",
        )
    )

    loads = len(settings.inputs.deferrable_loads)
    configured = get("number_of_deferrable_loads")
    arrays = {
        key: len(value)
        for key in (
            "nominal_power_of_deferrable_loads",
            "operating_hours_of_each_deferrable_load",
            "minimum_power_of_deferrable_loads",
            "treat_deferrable_load_as_semi_cont",
            "set_deferrable_load_single_constant",
            "set_deferrable_startup_penalty",
        )
        if isinstance(value := get(key), list)
    }
    short = {k: n for k, n in arrays.items() if n < loads}
    checks.append(
        _check(
            "deferrable_loads",
            "Deferrable loads",
            not short,
            f"{loads} load(s), arrays of ≥ {loads}",
            f"number_of_deferrable_loads={configured}; " + ", ".join(f"{k}={n}" for k, n in arrays.items()),
            "Per-load lists in the EMHASS configuration need at least one entry per deferrable load sent at run time.",
            "warning",
        )
    )

    batteries = get("number_of_batteries")
    if batteries is not None:  # EMHASS 0.18.0+
        try:
            count = int(batteries)
        except TypeError, ValueError:
            count = None
        checks.append(
            _check(
                "number_of_batteries",
                "Batteries",
                count is not None and count <= 1,
                "1",
                batteries,
                "EMHASS Lens sends one soc_init/soc_final (EMHASS applies them to every battery) and reads the "
                "fleet total P_batt and the first battery's SOC_opt_0; it doesn't drive batteries separately.",
                "warning",
            )
        )

    horizon_attrs = get("publish_horizon_attributes")
    if horizon_attrs is not None:  # EMHASS 0.18.2+
        checks.append(
            _check(
                "publish_horizon_attributes",
                "Horizon attributes",
                horizon_attrs is False,
                "false (optional)",
                horizon_attrs,
                "EMHASS attaches the whole horizon to every sensor it publishes (forecasts, deferrables_schedule, "
                "battery_scheduled_power, …). EMHASS Lens reads the plan from /api/v1/plan and doesn't need them; "
                "turn them off in EMHASS to keep Home Assistant's recorder small, unless a dashboard uses them.",
                "info",
            )
        )

    bias = get("weather_forecast_pv_quantile_bias")
    if bias is not None and settings.pv.source == "solcast":
        try:
            bias_value = float(bias)
        except TypeError, ValueError:
            bias_value = 0.0
        sending = settings.pv.send_p10 and settings.pv.field != "estimate10" and ver is not None and ver >= P10_VERSION
        why = ""
        if not sending:
            why = (
                "the estimate sent is P10 itself"
                if settings.pv.field == "estimate10"
                else "Settings → PV forecast → Send the P10 estimate too is off"
                if not settings.pv.send_p10
                else "EMHASS is older than 0.18.4"
            )
        checks.append(
            _check(
                "pv_quantile_bias",
                "PV P10 blend",
                (bias_value > 0) == sending,
                "> 0 with the P10 estimate sent" if sending else "0",
                bias,
                (
                    "EMHASS gets the P10 estimate with every run but ignores it while this is 0. Set it in EMHASS "
                    "(e.g. 0.3 = 30 % of the way toward P10) to plan more conservatively on uncertain days."
                    if sending
                    else f"EMHASS would blend toward P10 but doesn't get it: {why}."
                ),
                "info",
            )
        )

    needed = derive(settings).historic_days_to_retrieve
    history = get("historic_days_to_retrieve")
    try:
        history_ok = history is None or int(history) >= 2
    except TypeError, ValueError:
        history_ok = False
    checks.append(
        _check(
            "historic_days_to_retrieve",
            "History for the ML model",
            history_ok,
            f"{needed} (sent at run time)",
            history,
            "EMHASS Lens sends historic_days_to_retrieve with every run; this is EMHASS's own default.",
            "info",
        )
    )
    return checks


def _check(key: str, title: str, ok: bool, expected: Any, actual: Any, explanation: str, severity: str) -> Check:
    return Check(
        key, title, "ok" if ok else severity, str(expected), "—" if actual is None else str(actual), explanation
    )


def worst(checks: list[Check]) -> str:
    order = {"ok": 0, "info": 0, "warning": 1, "error": 2}
    level = max((order.get(c.status, 0) for c in checks), default=0)
    return {0: "ok", 1: "warning", 2: "error"}[level]
