"""Cost functions: detecting which one made a plan, and comparable totals (domain/mpc/compare.py)."""

from emhass_lens.domain.mpc.compare import COSTFUNS, costfun_of, plan_totals


def row(grid: float, batt: float = 0.0, pv: float = 0.0, load: float = 1000.0, **extra):
    return {"P_grid": grid, "P_batt": batt, "P_PV": pv, "P_Load": load, "P_deferrable0": 0.0, **extra}


def test_the_cost_fun_column_names_the_method() -> None:
    assert costfun_of([{"cost_fun_profit": 1.0}]) == "profit"
    assert costfun_of([{"cost_fun_cost": 1.0}]) == "cost"
    assert costfun_of([{"cost_fun_selfcons": 1.0}]) == "self-consumption"
    assert costfun_of([{"P_grid": 1.0}]) is None
    assert costfun_of([]) is None
    assert set(COSTFUNS) == {"profit", "cost", "self-consumption"}


def test_totals_are_energy_and_money_over_the_horizon() -> None:
    rows = [
        row(2000.0, batt=-1000.0, unit_load_cost=0.20, unit_prod_price=0.05),  # import 0.5 kWh at 20 c
        row(-4000.0, batt=1000.0, pv=6000.0, unit_load_cost=0.20, unit_prod_price=0.05),  # export 1 kWh at 5 c
        row(0.0, pv=1000.0, unit_load_cost=0.30, unit_prod_price=0.05, SOC_opt=0.7),
    ]
    t = plan_totals(rows)
    assert t.slots == 3 and t.hours == 0.75
    assert t.import_kwh == 0.5 and t.export_kwh == 1.0
    assert t.import_cost_eur == 0.1 and t.export_revenue_eur == 0.05 and t.net_cost_eur == 0.05
    assert t.pv_kwh == 1.75 and t.load_kwh == 0.75
    assert t.self_consumption_kwh == 0.75 and t.self_consumption_pct == round(100 * 0.75 / 1.75, 1)
    assert t.battery_charge_kwh == 0.25 and t.battery_discharge_kwh == 0.25
    assert t.soc_end == 0.7
    assert t.emhass_cost_profit_eur is None and t.emhass_objective is None and t.emhass_objective_column is None


def test_totals_take_prices_from_the_payload_when_the_plan_has_none_and_sum_emhass_columns() -> None:
    rows = [row(4000.0, cost_profit=-0.2, cost_fun_cost=-0.2), row(4000.0, cost_profit=-0.1, cost_fun_cost=-0.1)]
    t = plan_totals(rows, load_cost=[0.2, 0.1], prod_price=[0.0, 0.0])
    assert t.import_kwh == 2.0
    assert t.import_cost_eur == 0.3
    assert t.emhass_cost_profit_eur == -0.3
    assert t.emhass_objective == -0.3 and t.emhass_objective_column == "cost_fun_cost"


def test_totals_prefer_emhass_grid_split_and_multi_battery_soc() -> None:
    rows = [row(0.0, P_grid_pos=1000.0, P_grid_neg=-500.0, unit_load_cost=0.1, unit_prod_price=0.1, SOC_opt_0=0.4)]
    t = plan_totals(rows)
    assert t.import_kwh == 0.25 and t.export_kwh == 0.125
    assert t.soc_end == 0.4
    assert plan_totals([]).slots == 0 and plan_totals([]).self_consumption_pct is None
