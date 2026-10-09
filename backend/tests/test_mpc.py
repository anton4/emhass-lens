from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from emhass_lens.core.slots import slot_floor
from emhass_lens.domain import nordpool
from emhass_lens.domain.mpc.anchor import anchor_slot, hazard_wait, parse_version
from emhass_lens.domain.mpc.inputs import DeferrableReading, MpcInputs, Reading, read_bool, read_number
from emhass_lens.domain.mpc.payload import build
from emhass_lens.domain.mpc.validate import validate
from emhass_lens.domain.pv_solcast import parse as parse_pv
from emhass_lens.domain.tariffs.engine import price_slot
from emhass_lens.settings.model import Settings
from tests.fixtures.loader import nordpool as np_fixture
from tests.legacy import legacy_math

TZ = ZoneInfo("Europe/Tallinn")


def utc(*args: int) -> datetime:
    return datetime(*args, tzinfo=UTC)


@pytest.mark.parametrize(
    ("submit", "rule", "expected"),
    [
        (utc(2026, 10, 9, 11, 13, 0), "nearest", utc(2026, 10, 9, 11, 15)),
        (utc(2026, 10, 9, 11, 3, 0), "nearest", utc(2026, 10, 9, 11, 0)),
        (utc(2026, 10, 9, 11, 13, 0), "first", utc(2026, 10, 9, 11, 0)),
        (utc(2026, 10, 9, 11, 13, 0), "last", utc(2026, 10, 9, 11, 15)),
        (utc(2026, 10, 9, 11, 15, 0), "last", utc(2026, 10, 9, 11, 15)),
        (utc(2026, 10, 9, 11, 7, 30), "nearest", utc(2026, 10, 9, 11, 0)),  # tie, 11:00 is an even quarter
        (utc(2026, 10, 9, 11, 22, 30), "nearest", utc(2026, 10, 9, 11, 30)),  # tie, 11:30 is even
    ],
)
def test_anchor_slot(submit: datetime, rule: str, expected: datetime) -> None:
    assert anchor_slot(submit, rule) == expected


def test_hazard_wait_depends_on_version_and_rule() -> None:
    old, new = parse_version("0.17.9"), parse_version("v0.18.3")
    assert new == (0, 18, 3)
    at_13 = utc(2026, 10, 9, 11, 13, 0)
    assert hazard_wait(at_13, "nearest", new, 30) == 0
    near_flip = utc(2026, 10, 9, 11, 7, 20)  # 440 s into the slot, 10 s before nearest flips
    assert hazard_wait(near_flip, "nearest", new, 30) == 40
    near_start = utc(2026, 10, 9, 11, 14, 50)
    assert hazard_wait(near_start, "nearest", old, 30) == 40  # old EMHASS also floors
    assert hazard_wait(near_start, "nearest", new, 30) == 0


def prices() -> list:
    out = []
    for day in ("2026-10-09", "2026-10-10"):
        for e in nordpool.parse(np_fixture(day), date.fromisoformat(day), "EE").entries:
            out.append(price_slot(e.eur_mwh, e.start, e.end, Settings().prices.tariff, TZ, legacy_compat=True))
    return out


def pv_for(now_local: datetime):
    start = datetime(now_local.year, now_local.month, now_local.day, tzinfo=TZ)
    days = []
    for d in range(3):
        day_start = start + timedelta(days=d)
        days.append({"detailedForecast": [
            {"period_start": (day_start + timedelta(minutes=30 * i)).isoformat(), "pv_estimate": (i % 9) / 2}
            for i in range(48)
        ]})
    return days


def inputs_at(now: datetime, soc: str = "62", ev_on: bool = False, timesteps: str = "20") -> MpcInputs:
    attrs = pv_for(now.astimezone(TZ))
    pv = parse_pv({f"s{i}": {"attributes": a} for i, a in enumerate(attrs)}, "estimate")
    ev_state = {"state": "on" if ev_on else "off"}
    return MpcInputs(
        taken_at=now,
        prices=tuple(p for p in prices() if p.end > now),
        pv=pv,
        soc_init=read_number("soc_init", "sensor.ev6_battery_soc", {"state": soc}, now, 0.01),
        soc_final=read_number("soc_final", "input_number.emhass_target_soc", {"state": "80"}, now, 0.01, 0.8),
        deferrables=(DeferrableReading(
            name="EV",
            enabled=read_bool("enabled", "input_boolean.ev_charging_enabled", ev_state, now),
            nominal_power_w=11000,
            operating_hours=read_number("hours", "sensor.ev_operating_hours", {"state": "3"}, now),
            deadline_timesteps=read_number("deadline", "sensor.ev_charging_timesteps", {"state": timesteps}, now),
            single_constant=read_bool("single", "input_boolean.ev_force_continuous_charging", {"state": "off"}, now),
        ),),
        forecast_source="none",
        extend_days=1,
    )


@pytest.mark.parametrize("minute", [13, 3])
def test_payload_matches_legacy_at_run_times(minute: int) -> None:
    now = utc(2026, 10, 9, 11, minute, 0)
    settings = Settings()
    inputs = inputs_at(now)
    result = build(inputs, anchor_slot(now, "nearest"), slot_floor(now), settings)

    legacy_raw = []
    for day in ("2026-10-09", "2026-10-10"):
        legacy_raw += legacy_math.price_dict_from_response(np_fixture(day)).values()
    legacy_raw.sort(key=lambda p: p["start"])
    now_local = now.astimezone(TZ)
    from_now = legacy_math.prices_from_now(legacy_raw, legacy_math.LEGACY_DEFAULT_OPTS, now_local)
    pv = legacy_math.solcast_values(pv_for(now_local), "estimate", from_now["timestamps_left"], now_local)
    legacy = legacy_math.mpc_payload(from_now, pv, 0.62, 0.8, now_local, extend_days=0)

    assert result.payload["load_cost_forecast"] == legacy["load_cost_forecast"]
    assert result.payload["prod_price_forecast"] == legacy["prod_price_forecast"]
    assert result.payload["prediction_horizon"] == legacy["prediction_horizon"]
    assert result.payload["pv_power_forecast"] == legacy["pv_power_forecast"]
    for key in ("num_lags", "historic_days_to_retrieve", "delta_forecast_daily", "soc_init", "soc_final",
                "nominal_power_of_deferrable_loads", "set_deferrable_load_single_constant", "var_model",
                "load_forecast_method", "number_of_deferrable_loads"):
        assert result.payload[key] == legacy[key], key
    assert result.explain[0]["start"] == anchor_slot(now, "nearest").isoformat()


def test_ev_deadline_is_counted_from_the_anchor_not_one_slot_late() -> None:
    now = utc(2026, 10, 9, 11, 13, 0)  # anchor = next slot
    result = build(inputs_at(now, ev_on=True, timesteps="20"), anchor_slot(now, "nearest"), slot_floor(now), Settings())
    assert result.payload["end_timesteps_of_each_deferrable_load"] == [19]
    legacy = legacy_math.mpc_payload(
        {"import_prices": [0.1] * 50, "export_prices": [0.1] * 50, "timestamps_left": 50}, [0] * 50, 0.6, 0.8,
        now.astimezone(TZ), 0, {"enabled": True, "hours": 3, "timesteps": 20},
    )
    assert legacy["end_timesteps_of_each_deferrable_load"] == [20]  # the bug: not shifted with the lists
    assert result.payload["nominal_power_of_deferrable_loads"] == [11000]
    assert result.payload["operating_hours_of_each_deferrable_load"] == [3.0]


def test_unavailable_soc_refuses_instead_of_crashing() -> None:
    now = utc(2026, 10, 9, 11, 13, 0)
    inputs = inputs_at(now, soc="unavailable")
    result = build(inputs, anchor_slot(now, "nearest"), slot_floor(now), Settings())
    issues = validate(result, inputs, Settings())
    codes = {i.code for i in issues if i.level == "error"}
    assert codes == {"soc_unavailable"}
    assert "entity is 'unavailable'" in next(i.message for i in issues if i.code == "soc_unavailable")


def test_short_horizon_and_out_of_range_soc_are_errors() -> None:
    now = utc(2026, 10, 10, 21, 40, 0)  # only ~5 slots of prices left
    inputs = inputs_at(now, soc="6200")
    result = build(inputs, anchor_slot(now, "nearest"), slot_floor(now), Settings())
    codes = {i.code for i in validate(result, inputs, Settings()) if i.level == "error"}
    assert codes == {"horizon_too_short", "soc_out_of_range"}


def test_reading_explains_itself() -> None:
    now = utc(2026, 10, 9, 11, 0)
    r = read_number("soc", "sensor.x", {"state": "62", "last_updated": "2026-10-09T10:59:26+00:00"}, now, 0.01)
    assert r.value == pytest.approx(0.62)
    assert r.explain() == "0.62 from sensor.x, state '62', × 0.01, 34 s old"
    fallback = read_number("soc", "sensor.x", None, now, 0.01, default=0.8)
    assert fallback.value == 0.8
    assert fallback.source == "default"
    assert isinstance(fallback, Reading)
