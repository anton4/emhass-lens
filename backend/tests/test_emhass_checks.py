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


def test_p10_blend_check_matches_what_is_sent() -> None:
    settings = Settings()  # Solcast, P10 sent, estimate follows the select
    cfg = {**BASE, "weather_forecast_pv_quantile_bias": 0.0}
    unused = by_key(run_checks(cfg, "0.18.5", settings, None))["pv_quantile_bias"]
    assert unused.status == "info"
    assert "ignores it" in unused.explanation
    used = by_key(run_checks({**cfg, "weather_forecast_pv_quantile_bias": 0.3}, "0.18.5", settings, None))
    assert used["pv_quantile_bias"].status == "ok"

    old = by_key(run_checks({**cfg, "weather_forecast_pv_quantile_bias": 0.3}, "0.18.3", settings, None))
    assert old["pv_quantile_bias"].status == "info"
    assert "older than 0.18.4" in old["pv_quantile_bias"].explanation

    p10_only = Settings.model_validate({"pv": {"field": "estimate10"}})
    quiet = by_key(run_checks(cfg, "0.18.5", p10_only, None))["pv_quantile_bias"]
    assert quiet.status == "ok"  # bias 0 and nothing to blend: consistent
    off = Settings.model_validate({"pv": {"send_p10": False}})
    wanted = by_key(run_checks({**cfg, "weather_forecast_pv_quantile_bias": 0.3}, "0.18.5", off, None))
    assert wanted["pv_quantile_bias"].status == "info"
    assert "Send the P10" in wanted["pv_quantile_bias"].explanation

    no_pv = Settings.model_validate({"pv": {"source": "none"}})
    assert "pv_quantile_bias" not in by_key(run_checks(cfg, "0.18.5", no_pv, None))
