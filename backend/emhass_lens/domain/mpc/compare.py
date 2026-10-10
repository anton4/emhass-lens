"""Cost functions: which one a plan was made with, and totals computed the same way for every plan so the
three methods (profit, cost, self-consumption) can be compared on equal terms. Pure functions.

EMHASS's own objective lives in the plan as `cost_fun_profit`, `cost_fun_cost` or `cost_fun_selfcons`
(currency per slot, negative = money out); only the method that was used gets its column, so the column
name tells which method made the plan. `cost_profit` is in every plan.
"""

import re
from dataclasses import asdict, dataclass
from typing import Any

COSTFUNS = ("profit", "cost", "self-consumption")
COLUMN = {"profit": "cost_fun_profit", "cost": "cost_fun_cost", "self-consumption": "cost_fun_selfcons"}
LABEL = {"profit": "Profit", "cost": "Cost", "self-consumption": "Self-consumption"}
_BY_COLUMN = {v: k for k, v in COLUMN.items()}
_DEFERRABLE = re.compile(r"^P_deferrable\d+$")


def costfun_of(rows: list[dict[str, Any]]) -> str | None:
    """The cost function a plan was made with, from its cost_fun_* column; None when the plan has none."""
    for row in rows[:1]:
        for key in row:
            if key in _BY_COLUMN:
                return _BY_COLUMN[key]
    return None


def _num(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


@dataclass(frozen=True)
class Totals:
    """Energy and money over a plan's horizon, in kWh and EUR (positive cost = money out)."""

    slots: int
    hours: float
    import_kwh: float
    export_kwh: float
    import_cost_eur: float
    export_revenue_eur: float
    net_cost_eur: float  # import cost − export revenue
    pv_kwh: float
    load_kwh: float  # house load plus deferrable loads
    self_consumption_kwh: float  # PV not exported
    self_consumption_pct: float | None  # share of PV used on site; None without PV
    battery_charge_kwh: float
    battery_discharge_kwh: float
    soc_end: float | None  # 0–1
    emhass_cost_profit_eur: float | None  # Σ cost_profit (EMHASS's sign: positive = profit)
    emhass_objective: float | None  # Σ of the cost_fun_* column EMHASS optimised
    emhass_objective_column: str | None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def plan_totals(
    rows: list[dict[str, Any]],
    *,
    load_cost: list[float] | None = None,
    prod_price: list[float] | None = None,
    step_h: float = 0.25,
) -> Totals:
    """Totals of a plan. Prices come from the rows' unit_load_cost / unit_prod_price when EMHASS put them there,
    else positionally from the payload's lists."""
    imp_kwh = exp_kwh = imp_eur = exp_eur = pv = load = charge = discharge = 0.0
    profit_sum: float | None = None
    objective: float | None = None
    column = COLUMN.get(costfun_of(rows) or "")
    soc_end: float | None = None
    for i, row in enumerate(rows):
        grid = _num(row.get("P_grid"))
        grid_pos = _num(row.get("P_grid_pos"))
        grid_neg = _num(row.get("P_grid_neg"))
        if grid_pos is None:
            grid_pos = max(grid, 0.0) if grid is not None else 0.0
        if grid_neg is None:
            grid_neg = min(grid, 0.0) if grid is not None else 0.0
        buy = _num(row.get("unit_load_cost"))
        if buy is None and load_cost is not None and i < len(load_cost):
            buy = load_cost[i]
        sell = _num(row.get("unit_prod_price"))
        if sell is None and prod_price is not None and i < len(prod_price):
            sell = prod_price[i]
        imp = grid_pos * step_h / 1000
        exp = -grid_neg * step_h / 1000
        imp_kwh += imp
        exp_kwh += exp
        imp_eur += imp * (buy or 0.0)
        exp_eur += exp * (sell or 0.0)
        pv += (_num(row.get("P_PV")) or 0.0) * step_h / 1000
        house = _num(row.get("P_Load")) or 0.0
        deferrables = sum(_num(v) or 0.0 for k, v in row.items() if _DEFERRABLE.match(k))
        load += (house + deferrables) * step_h / 1000
        batt = _num(row.get("P_batt")) or 0.0
        if batt > 0:
            discharge += batt * step_h / 1000
        else:
            charge += -batt * step_h / 1000
        cp = _num(row.get("cost_profit"))
        if cp is not None:
            profit_sum = (profit_sum or 0.0) + cp
        if column is not None:
            ov = _num(row.get(column))
            if ov is not None:
                objective = (objective or 0.0) + ov
        soc = _num(row.get("SOC_opt"))
        if soc is None:
            soc = _num(row.get("SOC_opt_0"))
        if soc is not None:
            soc_end = soc
    self_cons = max(pv - exp_kwh, 0.0)
    return Totals(
        slots=len(rows),
        hours=round(len(rows) * step_h, 2),
        import_kwh=round(imp_kwh, 3),
        export_kwh=round(exp_kwh, 3),
        import_cost_eur=round(imp_eur, 4),
        export_revenue_eur=round(exp_eur, 4),
        net_cost_eur=round(imp_eur - exp_eur, 4),
        pv_kwh=round(pv, 3),
        load_kwh=round(load, 3),
        self_consumption_kwh=round(self_cons, 3),
        self_consumption_pct=round(100 * self_cons / pv, 1) if pv > 0 else None,
        battery_charge_kwh=round(charge, 3),
        battery_discharge_kwh=round(discharge, 3),
        soc_end=soc_end,
        emhass_cost_profit_eur=round(profit_sum, 4) if profit_sum is not None else None,
        emhass_objective=round(objective, 4) if objective is not None else None,
        emhass_objective_column=column,
    )
