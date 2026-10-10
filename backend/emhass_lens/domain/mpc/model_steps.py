"""How far EMHASS's ML load model can forecast, read from its error when the horizon is longer.

A model made by forecast-model-tune predicts only as many steps as the lag count the tuner picked (6 h to 3 days),
not the num_lags a run sends. When the MPC horizon is longer, EMHASS's load-forecast stage stops with
"Number of ML predict forcast data generated (lags_opt): 144" and "Unable to obtain: 233 lags_opt values".
"""

import re

_STEPS = re.compile(r"data generated \(lags_opt\):\s*(\d+)")
_WANTED = re.compile(r"Unable to obtain:\s*(\d+)\s+lags_opt values")


def short_model(body: str) -> tuple[int, int] | None:
    """(steps the model forecasts, steps the run asked for) when EMHASS refused a run for that reason."""
    wanted = _WANTED.search(body)
    steps = _STEPS.search(body)
    if wanted is None or steps is None:
        return None
    n, m = int(steps.group(1)), int(wanted.group(1))
    if n <= 0 or n >= m:
        return None
    return n, m
