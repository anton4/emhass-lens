"""The EMHASS configuration checks, including the keys that arrived with EMHASS 0.18.x."""

from typing import Any

from emhass_lens.domain.emhass_checks import run_checks, worst
from emhass_lens.settings.model import Settings

BASE: dict[str, Any] = {
    "optimization_time_step": 15,
    "method_ts_round": "nearest",
    "continual_publish": False,
    "sensor_power_load_no_var_loads": "sensor.power_load_no_var_loads",
    "number_of_deferrable_loads": 1,
    "nominal_power_of_deferrable_loads": [11000],
    "historic_days_to_retrieve": 2,
}


def by_key(checks: list) -> dict[str, Any]:
    return {c.key: c for c in checks}


def test_version_advice_steps_through_the_0_18_releases() -> None:
    settings = Settings()
    assert by_key(run_checks(BASE, "0.17.8", settings, None))["version"].status == "error"
    assert by_key(run_checks(BASE, "0.18.1", settings, None))["version"].status == "warning"
    older = by_key(run_checks(BASE, "0.18.3", settings, None))["version"]
    assert older.status == "info"
    assert "0.18.5" in older.expected
    assert by_key(run_checks(BASE, "v0.18.5", settings, None))["version"].status == "ok"
    assert worst(run_checks(BASE, "0.18.3", settings, None)) == "ok"  # info never blocks


def test_more_than_one_battery_is_a_warning() -> None:
    settings = Settings()
    assert "number_of_batteries" not in by_key(run_checks(BASE, "0.18.5", settings, None))  # pre-0.18 config
    one = by_key(run_checks({**BASE, "number_of_batteries": 1}, "0.18.5", settings, None))["number_of_batteries"]
    assert one.status == "ok"
    two = by_key(run_checks({**BASE, "number_of_batteries": 2}, "0.18.5", settings, None))["number_of_batteries"]
    assert two.status == "warning"
    assert "SOC_opt_0" in two.explanation


def test_horizon_attributes_are_only_a_hint() -> None:
    settings = Settings()
    on = by_key(run_checks({**BASE, "publish_horizon_attributes": True}, "0.18.5", settings, None))
    assert on["publish_horizon_attributes"].status == "info"
    off = by_key(run_checks({**BASE, "publish_horizon_attributes": False}, "0.18.5", settings, None))
    assert off["publish_horizon_attributes"].status == "ok"
    assert worst(run_checks({**BASE, "publish_horizon_attributes": True}, "0.18.5", settings, None)) == "ok"


def test_no_p10_blend_check_since_p10_is_not_sent() -> None:
    cfg = {**BASE, "weather_forecast_pv_quantile_bias": 0.3}
    assert "pv_quantile_bias" not in by_key(run_checks(cfg, "0.18.5", Settings(), None))


def test_no_export_needs_emhass_0_16_with_curtailment() -> None:
    off = Settings()
    assert "no_export" not in by_key(run_checks(BASE, "0.18.5", off, None))
    on = Settings.model_validate({"emhass": {"mpc": {"no_export_at_or_below": 0.03}}})
    ok = by_key(run_checks({**BASE, "compute_curtailment": True}, "0.18.5", on, None))["no_export"]
    assert ok.status == "ok"
    no_curtailment = by_key(run_checks({**BASE, "compute_curtailment": False}, "0.18.5", on, None))["no_export"]
    assert no_curtailment.status == "warning"
    assert "compute_curtailment" in no_curtailment.explanation
    too_old = by_key(run_checks({**BASE, "compute_curtailment": True}, "0.15.6", on, None))["no_export"]
    assert too_old.status == "warning"
