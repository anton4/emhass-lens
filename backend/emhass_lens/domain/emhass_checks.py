"""Compares EMHASS's effective configuration (GET /get-config) with what EMHASS Lens relies on."""

from dataclasses import asdict, dataclass
from typing import Any

from emhass_lens.domain.mpc.anchor import parse_version
from emhass_lens.domain.mpc.payload import derive
from emhass_lens.settings.model import Settings

MIN_VERSION = (0, 17, 9)  # GET /api/v1/plan
RACE_FIXED_VERSION = (0, 18, 2)


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
    else:
        checks.append(Check("version", "EMHASS version", "ok", "≥ 0.18.2", version or "?", "Supported."))

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
