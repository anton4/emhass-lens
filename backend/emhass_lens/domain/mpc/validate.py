"""Checks a built payload before it may be sent. Errors refuse the run; warnings are recorded."""

from emhass_lens.domain.issues import Issue
from emhass_lens.domain.mpc.inputs import MpcInputs
from emhass_lens.domain.mpc.payload import BuildResult, is_finite_list
from emhass_lens.settings.model import Settings


def validate(result: BuildResult, inputs: MpcInputs, settings: Settings) -> list[Issue]:
    issues = list(inputs.issues) + list(result.issues)
    p = result.payload
    mpc = settings.emhass.mpc

    if result.horizon < mpc.min_horizon:
        issues.append(
            Issue(
                "error",
                "horizon_too_short",
                f"Only {result.horizon} future slot(s) have prices; at least {mpc.min_horizon} are needed",
                hint="Check the Nord Pool fetch on the Inputs page.",
            )
        )
    lists = ["load_cost_forecast", "prod_price_forecast", "pv_power_forecast"]
    if "pv_power_forecast_p10" in p:  # EMHASS rejects the run when the pair doesn't line up
        lists.append("pv_power_forecast_p10")
    if isinstance(p.get("maximum_power_to_grid"), list):  # a wrong length makes EMHASS use the first value everywhere
        lists.append("maximum_power_to_grid")
    for key in lists:
        values = p.get(key) or []
        if len(values) != result.horizon:
            issues.append(
                Issue("error", "length_mismatch", f"{key} has {len(values)} values, horizon is {result.horizon}")
            )
        elif not is_finite_list(values):
            issues.append(Issue("error", "not_finite", f"{key} contains a value that is not a finite number"))

    for reading, label in ((inputs.soc_init, "Battery SOC now"), (inputs.soc_final, "Battery SOC at the end")):
        if reading.value is None:
            issues.append(
                Issue(
                    "error",
                    "soc_unavailable",
                    f"{label}: {reading.issue or 'no value'}",
                    hint="Fix the entity, or choose 'Use the default' under Settings → Inputs.",
                )
            )
        elif not 0.0 <= float(reading.value) <= 1.0:
            issues.append(
                Issue(
                    "error",
                    "soc_out_of_range",
                    f"{label} is {reading.value} (must be 0–1); check the 'Multiply by' setting",
                )
            )
        elif reading.issue:
            issues.append(Issue("warning", "soc_default", f"{label}: {reading.issue}"))

    for i, end in enumerate(p.get("end_timesteps_of_each_deferrable_load") or []):
        if end > result.horizon:
            name = inputs.deferrables[i].name if i < len(inputs.deferrables) else f"load {i}"
            issues.append(
                Issue(
                    "warning",
                    "deadline_beyond_horizon",
                    f"{name}: deadline step {end} is beyond the horizon ({result.horizon}); EMHASS will ignore it",
                )
            )
    return issues
