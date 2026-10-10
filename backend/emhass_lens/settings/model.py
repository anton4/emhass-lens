"""The App's settings: one validated document, edited in the UI, versioned in app.db.

Each field carries UI hints in json_schema_extra["ui"] so the frontend can render the form from
the JSON schema alone. Defaults reproduce what the legacy HACS integration hard-coded.
"""

from functools import cache
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SCHEMA_VERSION = 3

TIME_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d$"
Level = Literal["debug", "info", "warning", "error"]


def ui(
    *,
    unit: str | None = None,
    widget: str | None = None,
    advanced: bool = False,
    domain: str | list[str] | None = None,
    help: str | None = None,
    labels: dict[str, str] | None = None,
) -> dict[str, Any]:
    hints: dict[str, Any] = {}
    if unit:
        hints["unit"] = unit
    if widget:
        hints["widget"] = widget
    if advanced:
        hints["advanced"] = True
    if domain:
        hints["domain"] = domain
    if help:
        hints["help"] = help
    if labels:
        hints["labels"] = labels
    return {"ui": hints}


class Section(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True)


EntityId = Annotated[str, Field(pattern=r"^$|^[a-z_]+\.[a-z0-9_]+$")]


# --- EMHASS ----------------------------------------------------------------------------------------


class EmhassMpc(Section):
    auto: bool = Field(
        default=False,
        title="Run MPC automatically",
        description="Run naive-mpc-optim every quarter-hour. Only acts when the mode is dry run or live.",
    )
    slot_offset_s: int = Field(
        default=780,
        ge=0,
        lt=900,
        title="Run at (seconds into each quarter)",
        description="780 = mm:13:00, two minutes before the next quarter starts, so the plan for the "
        "next slot is ready before it is published.",
        json_schema_extra=ui(unit="s", widget="quarter_offset"),
    )
    min_horizon: int = Field(
        default=8,
        ge=1,
        le=96,
        title="Minimum horizon",
        description="Refuse to run when fewer future slots than this have prices.",
        json_schema_extra=ui(unit="slots", advanced=True),
    )
    max_horizon: int = Field(
        default=672,
        ge=8,
        le=1344,
        title="Maximum horizon",
        description="Cap the number of slots sent to EMHASS.",
        json_schema_extra=ui(unit="slots", advanced=True),
    )
    costfun: Literal["default", "profit", "cost", "self-consumption"] = Field(
        default="default",
        title="Cost function",
        description="What EMHASS optimises for. Profit: import cost minus export revenue (EMHASS's usual default). "
        "Cost: import cost only, exports earn nothing. Self-consumption: use as much PV on site as possible. "
        "'EMHASS's own setting' sends nothing and leaves EMHASS's configured costfun in charge. Needs EMHASS 0.18 "
        "or newer; the plan read back shows which one EMHASS used, and Health warns if it was ignored.",
        json_schema_extra=ui(
            labels={
                "default": "EMHASS's own setting",
                "profit": "Profit",
                "cost": "Cost",
                "self-consumption": "Self-consumption",
            }
        ),
    )
    compare_costfuns: bool = Field(
        default=False,
        title="Compare cost functions on every run",
        description="Before each live plan, also run the other two cost functions with the same inputs, so the Plan "
        "page can show what each would do and cost. Two extra optimisations per quarter-hour (each a few seconds to "
        "a minute, EMHASS's latest plan is only final once all three are done), so move the MPC time earlier if "
        "publishing gets tight. 'Compare now' on the Plan page does the same once.",
    )
    hazard_guard_s: int = Field(
        default=30,
        ge=0,
        le=120,
        title="Grid-boundary guard",
        description="Older EMHASS versions (< 0.18.2) can fail when a run starts within this many seconds "
        "of a slot rounding boundary; the run waits it out.",
        json_schema_extra=ui(unit="s", advanced=True),
    )


class EmhassPublish(Section):
    enabled: bool = Field(
        default=True,
        title="Publish each quarter",
        description="Call publish-data right after each quarter starts (live mode), so EMHASS's "
        "sensor.p_* entities show the slot that just began.",
    )
    slot_offset_s: int = Field(
        default=2,
        ge=0,
        lt=300,
        title="Publish at (seconds into each quarter)",
        json_schema_extra=ui(unit="s", widget="quarter_offset"),
    )


SklearnModel = Literal[
    "KNeighborsRegressor",
    "RandomForestRegressor",
    "GradientBoostingRegressor",
    "RidgeRegression",
    "MLPRegressor",
]


class EmhassMl(Section):
    var_model: EntityId = Field(
        default="sensor.house_power_without_deferrable",
        title="Load sensor for the ML model",
        description="The household power sensor (without deferrable loads) EMHASS learns from.",
        json_schema_extra=ui(widget="entity", domain="sensor"),
    )
    sklearn_model: SklearnModel = Field(default="KNeighborsRegressor", title="Model type")
    historic_days: int = Field(default=30, ge=9, le=365, title="Training history", json_schema_extra=ui(unit="days"))
    num_lags: int | None = Field(
        default=None,
        ge=24,
        le=2016,
        title="Lags",
        description="Leave empty to derive it like before: 192 + 96 × forecast extension days.",
        json_schema_extra=ui(unit="slots", advanced=True),
    )
    n_trials: int = Field(default=10, ge=5, le=100, title="Tuning trials", json_schema_extra=ui(advanced=True))


class EmhassTimeouts(Section):
    mpc: int = Field(default=180, ge=10, le=900, title="MPC", json_schema_extra=ui(unit="s"))
    publish: int = Field(default=60, ge=5, le=300, title="Publish", json_schema_extra=ui(unit="s"))
    predict: int = Field(default=180, ge=10, le=900, title="ML predict", json_schema_extra=ui(unit="s"))
    fit: int = Field(default=3600, ge=60, le=14400, title="ML fit", json_schema_extra=ui(unit="s"))
    tune: int = Field(default=7200, ge=60, le=28800, title="ML tune", json_schema_extra=ui(unit="s"))


class Emhass(Section):
    base_url: str = Field(
        default="",
        title="EMHASS address",
        description="Base URL of the EMHASS App, e.g. http://5b918bf2-emhass:5000. Leave empty to look "
        "it up through the Supervisor.",
        json_schema_extra=ui(widget="url"),
    )
    mode: Literal["off", "dry_run", "live"] = Field(
        default="off",
        title="Mode",
        description="Off: never calls EMHASS actions. Dry run: builds and checks every payload but does "
        "not send it. Live: runs and publishes.",
        json_schema_extra=ui(labels={"off": "Off", "dry_run": "Dry run", "live": "Live"}),
    )
    mpc: EmhassMpc = Field(default=EmhassMpc(), title="MPC optimization")
    publish: EmhassPublish = Field(default=EmhassPublish(), title="Publishing")
    ml: EmhassMl = Field(default=EmhassMl(), title="ML load forecast")
    timeouts: EmhassTimeouts = Field(default=EmhassTimeouts(), title="Timeouts", json_schema_extra=ui(advanced=True))
    extra_runtime_params: dict[str, Any] = Field(
        default_factory=dict,
        title="Extra runtime parameters",
        description="Added to every MPC payload as-is (shown in each run's Explain view).",
        json_schema_extra=ui(widget="json", advanced=True),
    )

    @field_validator("base_url")
    @classmethod
    def _url(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        if value and not value.startswith(("http://", "https://")):
            raise ValueError("must start with http:// or https://")
        return value


# --- Inputs read from Home Assistant ---------------------------------------------------------------


class EntityInput(Section):
    entity: EntityId = Field(json_schema_extra=ui(widget="entity", domain=["sensor", "input_number"]))
    scale: float = Field(
        default=0.01,
        title="Multiply by",
        description="0.01 turns a percentage into the 0–1 EMHASS expects.",
    )
    on_unavailable: Literal["refuse", "default"] = Field(
        default="refuse",
        title="When unavailable",
        description="Refuse: skip the run and raise a problem. Default: use the value below.",
        json_schema_extra=ui(labels={"refuse": "Skip the run", "default": "Use the default"}),
    )
    default: float | None = Field(default=None, title="Default", ge=0, le=1)

    @model_validator(mode="after")
    def _default_needed(self) -> EntityInput:
        if self.on_unavailable == "default" and self.default is None:
            raise ValueError("a default value is needed when 'When unavailable' is 'Use the default'")
        return self


class DeferrableLoad(Section):
    name: str = Field(default="EV", min_length=1, max_length=40)
    enabled_entity: EntityId = Field(
        default="input_boolean.ev_charging_enabled",
        title="Enabled when on",
        json_schema_extra=ui(widget="entity", domain=["input_boolean", "switch", "binary_sensor"]),
    )
    nominal_power_w: int = Field(default=11000, ge=0, le=100000, title="Power", json_schema_extra=ui(unit="W"))
    operating_hours_entity: EntityId = Field(
        default="sensor.ev_operating_hours",
        title="Operating hours from",
        json_schema_extra=ui(widget="entity", domain=["sensor", "input_number"]),
    )
    deadline_timesteps_entity: EntityId = Field(
        default="sensor.ev_charging_timesteps",
        title="Deadline (time steps from now) from",
        description="Number of 15-minute steps from now by which the load must be done; 0 = no deadline.",
        json_schema_extra=ui(widget="entity", domain=["sensor", "input_number"]),
    )
    single_constant_entity: EntityId = Field(
        default="input_boolean.ev_force_continuous_charging",
        title="Run in one block when on",
        json_schema_extra=ui(widget="entity", domain=["input_boolean", "switch"]),
    )
    running_entity: EntityId = Field(
        default="",
        title="Running now when",
        description="Optional: an entity that says the load runs right now, e.g. the charger's state sensor. "
        "EMHASS (0.18.2+) then plans a load that is already on as on, instead of scheduling a fresh start. "
        "Leave empty to send nothing.",
        json_schema_extra=ui(widget="entity", domain=["sensor", "binary_sensor", "switch", "input_boolean"]),
    )
    running_states: list[str] = Field(
        default_factory=lambda: ["on"],
        title="Running states",
        description="The states of that entity that mean running, e.g. on, charging or 4.",
        json_schema_extra=ui(widget="json", advanced=True),
    )


class Inputs(Section):
    soc_init: EntityInput = Field(
        default=EntityInput(entity="sensor.ev6_battery_soc", scale=0.01, on_unavailable="refuse"),
        title="Battery state of charge now",
    )
    soc_final: EntityInput = Field(
        default=EntityInput(entity="input_number.emhass_target_soc", scale=0.01, on_unavailable="default", default=0.8),
        title="Battery state of charge at the end of the horizon",
    )
    deferrable_loads: list[DeferrableLoad] = Field(
        default_factory=lambda: [DeferrableLoad()],
        title="Deferrable loads",
        max_length=4,
    )


# --- Prices -----------------------------------------------------------------------------------------


class NordpoolPolling(Section):
    area: Literal["EE", "FI", "LV", "LT"] = Field(default="EE", title="Bidding zone")
    publish_time: str = Field(
        default="13:45",
        pattern=TIME_PATTERN,
        title="Day-ahead results expected at",
        description="Local time from which tomorrow's prices are polled.",
        json_schema_extra=ui(widget="time"),
    )
    fast_until: str = Field(
        default="15:00", pattern=TIME_PATTERN, title="Poll fast until", json_schema_extra=ui(widget="time")
    )
    fast_interval_min: int = Field(default=5, ge=1, le=60, title="Fast poll interval", json_schema_extra=ui(unit="min"))
    slow_interval_min: int = Field(
        default=60, ge=5, le=1440, title="Slow poll interval", json_schema_extra=ui(unit="min")
    )


class NetworkRates(Section):
    day: float = Field(default=0.0369, ge=0, title="Day", json_schema_extra=ui(unit="€/kWh"))
    night: float = Field(default=0.021, ge=0, title="Night / weekend / holiday", json_schema_extra=ui(unit="€/kWh"))
    day_peak: float | None = Field(
        default=None,
        ge=0,
        title="Day peak",
        description="Working days 09–12 and 16–20, November–March. Empty = no peak rate.",
        json_schema_extra=ui(unit="€/kWh"),
    )
    holiday_peak: float | None = Field(
        default=None,
        ge=0,
        title="Weekend peak",
        description="Weekends and holidays 16–20, November–March. Empty = no peak rate.",
        json_schema_extra=ui(unit="€/kWh"),
    )


class NightWindow(Section):
    start: str = Field(default="22:00", pattern=TIME_PATTERN, json_schema_extra=ui(widget="time"))
    end: str = Field(default="07:00", pattern=TIME_PATTERN, json_schema_extra=ui(widget="time"))
    clock_basis: Literal["local", "standard_time"] = Field(
        default="local",
        title="Clock",
        description="Local: the window follows the wall clock. Standard time: it is defined in winter "
        "time, so in summer it shifts one hour later (e.g. 23–08).",
        json_schema_extra=ui(labels={"local": "Wall clock", "standard_time": "Winter time"}),
    )


class Tariff(Section):
    package: Literal["vork1", "vork2", "vork4", "vork5", "custom"] = Field(
        default="custom",
        title="Network package",
        description="Elektrilevi Võrk 1/2/4/5 bring their own network rates; Custom uses the rates below.",
        json_schema_extra=ui(
            labels={
                "vork1": "Võrk 1",
                "vork2": "Võrk 2",
                "vork4": "Võrk 4",
                "vork5": "Võrk 5",
                "custom": "Custom",
            }
        ),
    )
    margin: float = Field(default=0.00328, ge=0, title="Seller margin", json_schema_extra=ui(unit="€/kWh"))
    renewable: float = Field(
        default=0.0084, ge=0, title="Renewable energy fee (taastuvenergia tasu)", json_schema_extra=ui(unit="€/kWh")
    )
    excise: float = Field(
        default=0.0021, ge=0, title="Electricity excise (aktsiis)", json_schema_extra=ui(unit="€/kWh")
    )
    balancing: float = Field(
        default=0.00373, ge=0, title="Balancing capacity fee (tasakaalustamine)", json_schema_extra=ui(unit="€/kWh")
    )
    supply_security: float = Field(
        default=0.00758, ge=0, title="Security of supply fee (varustuskindlus)", json_schema_extra=ui(unit="€/kWh")
    )
    vat_pct: float = Field(default=24.0, ge=0, le=100, title="VAT", json_schema_extra=ui(unit="%"))
    network: NetworkRates = Field(default=NetworkRates(), title="Network rates (custom package)")
    night_window: NightWindow = Field(default=NightWindow(), title="Night rate hours")
    export_margin: float = Field(default=0.01, ge=0, title="Export margin", json_schema_extra=ui(unit="€/kWh"))
    export_balancing: float = Field(
        default=0.00373, ge=0, title="Export balancing fee", json_schema_extra=ui(unit="€/kWh")
    )


class PriceSensors(Section):
    import_entity: EntityId = Field(
        default="sensor.nordpool_import",
        title="Import price sensor",
        description="A Home Assistant sensor whose raw_today / raw_tomorrow (or raw_all) attribute lists {start, end, "
        "value} in €/kWh including VAT, like a Nord Pool template. Leave empty to skip the comparison.",
        json_schema_extra=ui(widget="entity", domain="sensor"),
    )
    export_entity: EntityId = Field(
        default="sensor.nordpool_export",
        title="Export price sensor",
        description="Same shape, for the export price. Leave empty to skip.",
        json_schema_extra=ui(widget="entity", domain="sensor"),
    )
    tolerance: float = Field(
        default=0.0001,
        ge=0,
        le=0.1,
        title="Tolerance",
        description="Differences up to this count as equal (templates usually round to 4 decimals).",
        json_schema_extra=ui(unit="€/kWh"),
    )


class Prices(Section):
    nordpool: NordpoolPolling = Field(default=NordpoolPolling(), title="Nord Pool day-ahead")
    tariff: Tariff = Field(default=Tariff(), title="Tariff")
    sensors: PriceSensors = Field(default=PriceSensors(), title="Compare with your price sensors")


# --- Forecasts ---------------------------------------------------------------------------------------


class EeForecast(Section):
    api_key: str = Field(
        default="",
        title="API key",
        description="eupowerprices.com API key.",
        json_schema_extra=ui(widget="secret"),
    )
    poll_hours: int = Field(default=1, ge=1, le=24, title="Poll every", json_schema_extra=ui(unit="h"))


class FiForecast(Section):
    entity: EntityId = Field(
        default="sensor.nordpool_predict_fi_price",
        title="Forecast entity",
        json_schema_extra=ui(widget="entity", domain="sensor"),
    )
    attribute: str = Field(default="forecast", title="Attribute with the forecast list")
    unit: Literal["c_per_kwh", "eur_per_kwh", "eur_per_mwh"] = Field(
        default="c_per_kwh",
        title="Unit",
        json_schema_extra=ui(labels={"c_per_kwh": "c/kWh", "eur_per_kwh": "€/kWh", "eur_per_mwh": "€/MWh"}),
    )
    vat_included_pct: float = Field(
        default=0.0,
        ge=0,
        le=100,
        title="VAT included in the values",
        description="Removed before Estonian tariffs are applied. 0 if the values exclude VAT.",
        json_schema_extra=ui(unit="%"),
    )


class Forecast(Section):
    source: Literal["none", "ee_eupowerprices", "fi_ha_entity"] = Field(
        default="none",
        title="Price forecast",
        description="Extends the price horizon beyond the published day-ahead prices.",
        json_schema_extra=ui(
            labels={
                "none": "None",
                "ee_eupowerprices": "Estonia (EE) – eupowerprices.com",
                "fi_ha_entity": "Finland (FI) – nordpool-predict-fi entity",
            }
        ),
    )
    extend_days: int = Field(default=1, ge=1, le=7, title="Extend by", json_schema_extra=ui(unit="days"))
    ee: EeForecast = Field(default=EeForecast(), title="eupowerprices.com")
    fi: FiForecast = Field(default=FiForecast(), title="nordpool-predict-fi")

    @model_validator(mode="after")
    def _key_needed(self) -> Forecast:
        if self.source == "ee_eupowerprices" and not self.ee.api_key:
            raise ValueError("the eupowerprices.com forecast needs an API key")
        return self


# --- PV ------------------------------------------------------------------------------------------------


class Pv(Section):
    source: Literal["solcast", "none"] = Field(
        default="solcast",
        title="PV forecast",
        json_schema_extra=ui(labels={"solcast": "Solcast (HA integration)", "none": "None"}),
    )
    entity_prefix: str = Field(
        default="sensor.solcast_pv_forecast_forecast_",
        title="Solcast sensor prefix",
        description="Day sensors are <prefix>today, <prefix>tomorrow, <prefix>day_3 … day_7.",
    )
    days: int = Field(default=7, ge=1, le=7, title="Days to read", json_schema_extra=ui(unit="days"))
    field: Literal["from_select", "estimate", "estimate10", "estimate90"] = Field(
        default="from_select",
        title="Estimate",
        json_schema_extra=ui(
            labels={
                "from_select": "Follow the Solcast select entity",
                "estimate": "Estimate (P50)",
                "estimate10": "Pessimistic (P10)",
                "estimate90": "Optimistic (P90)",
            }
        ),
    )
    field_select_entity: EntityId = Field(
        default="select.solcast_pv_forecast_use_forecast_field",
        title="Solcast select entity",
        json_schema_extra=ui(widget="entity", domain="select", advanced=True),
    )
    send_p10: bool = Field(
        default=True,
        title="Send the P10 estimate too",
        description="EMHASS 0.18.4 and later take the pessimistic P10 estimate next to the forecast and blend the "
        "two by their own weather_forecast_pv_quantile_bias setting (0 = ignore P10). Not sent while the estimate "
        "above is P10 itself.",
    )
    scale: float = Field(default=1.0, ge=0, le=10, title="Multiply by", json_schema_extra=ui(advanced=True))


# --- Measurements (what actually happened, for the Plan page's history and accuracy) --------------------


class MeasuredPower(Section):
    entity: EntityId = Field(
        default="",
        title="Entity",
        description="A sensor in watts (W); a kW sensor works with Multiply by 1000. Leave empty to skip this "
        "quantity.",
        json_schema_extra=ui(widget="entity", domain="sensor"),
    )
    scale: float = Field(
        default=1.0,
        gt=0,
        le=10000,
        title="Multiply by",
        description="Brings the sensor to EMHASS's units: 1 for W, 1000 for kW; for the state of charge 0.01 turns % "
        "into the 0–1 EMHASS uses.",
    )
    invert: bool = Field(
        default=False,
        title="Opposite sign",
        description="Tick when the sensor's sign is the reverse of EMHASS's (see the quantity's title).",
    )


class Measurements(Section):
    grid: MeasuredPower = Field(
        default=MeasuredPower(),
        title="Grid power, W (+ import, − export, like EMHASS's P_grid)",
        description="The power at the grid connection in watts. Many meters count export as positive: tick "
        "Opposite sign then.",
    )
    battery: MeasuredPower = Field(
        default=MeasuredPower(),
        title="Battery power, W (+ discharge, − charge, like EMHASS's P_batt)",
        description="The battery's power in watts; for a sensor that counts charging as positive, tick Opposite sign.",
    )
    pv: MeasuredPower = Field(
        default=MeasuredPower(entity="sensor.sofar_pv_power_total_watt"),
        title="PV power, W",
        description="The PV production in watts, always positive.",
    )
    load: MeasuredPower = Field(
        default=MeasuredPower(entity="sensor.house_power_without_deferrable"),
        title="House load without deferrable loads, W (what EMHASS forecasts as P_Load)",
        description="The household consumption in watts without the deferrable loads (the EV charger), usually the "
        "same sensor EMHASS learns from.",
    )
    soc: MeasuredPower = Field(
        default=MeasuredPower(entity="sensor.ev6_battery_soc", scale=0.01),
        title="Battery state of charge, %",
        description="The battery's state of charge; a sensor in % needs Multiply by 0.01 (the default here), a sensor "
        "that already reports 0–1 needs 1.",
    )
    backfill_days: int = Field(
        default=10,
        ge=1,
        le=30,
        title="Read history back",
        description="How far back to read from Home Assistant's recorder on start and after a change here. "
        "The recorder keeps 10 days by default.",
        json_schema_extra=ui(unit="days"),
    )
    keep_days: int = Field(default=120, ge=7, le=730, title="Keep measurements", json_schema_extra=ui(unit="days"))


# --- Outputs, health, logging ------------------------------------------------------------------------


class MqttBroker(Section):
    host: str = Field(
        default="",
        title="Broker host",
        description="Leave empty to use the Mosquitto broker App (credentials come from the Supervisor).",
    )
    port: int = Field(default=1883, ge=1, le=65535, title="Port")
    username: str = Field(default="", title="Username")
    password: str = Field(default="", title="Password", json_schema_extra=ui(widget="secret"))
    tls: bool = Field(default=False, title="TLS")


class Outputs(Section):
    mqtt_enabled: bool = Field(
        default=False,
        title="MQTT entities",
        description="Publish the EMHASS Lens device (prices, problem, last MPC, Auto MPC switch, Run MPC "
        "button) through MQTT discovery. Needs the Mosquitto broker App.",
    )
    discovery_prefix: str = Field(
        default="homeassistant", title="Discovery prefix", json_schema_extra=ui(advanced=True)
    )
    topic_prefix: str = Field(
        default="emhass_lens", pattern=r"^[A-Za-z0-9_/-]+$", title="Topic prefix", json_schema_extra=ui(advanced=True)
    )
    broker: MqttBroker = Field(default=MqttBroker(), title="MQTT broker", json_schema_extra=ui(advanced=True))
    fire_event: bool = Field(
        default=True,
        title="Fire an event after each publish",
        description="emhass_lens_plan_published, with the current slot's plan values in the event data.",
    )


class Health(Section):
    tomorrow_warn_after: str = Field(
        default="15:30",
        pattern=TIME_PATTERN,
        title="Warn if tomorrow's prices are missing after",
        json_schema_extra=ui(widget="time"),
    )
    tomorrow_error_after: str = Field(
        default="18:00",
        pattern=TIME_PATTERN,
        title="Error if tomorrow's prices are missing after",
        json_schema_extra=ui(widget="time"),
    )
    problem_grace_min: int = Field(
        default=10,
        ge=0,
        le=240,
        title="Notify after a problem lasts",
        json_schema_extra=ui(unit="min"),
    )
    plan_max_age_slots: int = Field(
        default=2, ge=1, le=96, title="Plan is stale after", json_schema_extra=ui(unit="slots")
    )


class Notifications(Section):
    persistent: bool = Field(
        default=False,
        title="Home Assistant notifications",
        description="Raise a persistent notification for problems that last longer than the grace time.",
    )
    mobile_service: str = Field(
        default="",
        pattern=r"^$|^notify\.[a-z0-9_]+$",
        title="Mobile notify service",
        description="e.g. notify.mobile_app_my_phone (Developer tools → Actions). Empty: no phone messages. "
        "Used by the EV charger control.",
    )


class Logging(Section):
    level: Literal["default", "debug", "info", "warning", "error"] = Field(
        default="default",
        title="Log level",
        description="Default follows the log_level option in the App's Configuration tab.",
    )
    component_levels: dict[str, Level] = Field(
        default_factory=dict,
        title="Per-component levels",
        description='e.g. {"emhass": "debug"} for more detail from one part only.',
        json_schema_extra=ui(widget="json", advanced=True),
    )


class Retention(Section):
    logs_days: int = Field(default=7, ge=1, le=90, title="Keep logs", json_schema_extra=ui(unit="days"))
    artifacts_days: int = Field(default=7, ge=1, le=90, title="Keep run details", json_schema_extra=ui(unit="days"))
    runs_days: int = Field(default=30, ge=1, le=365, title="Keep run summaries", json_schema_extra=ui(unit="days"))
    problems_days: int = Field(
        default=90, ge=7, le=365, title="Keep problem history", json_schema_extra=ui(unit="days")
    )
    sessions_days: int = Field(
        default=180, ge=7, le=730, title="Keep market sessions", json_schema_extra=ui(unit="days")
    )
    settings_revisions: int = Field(
        default=100,
        ge=20,
        le=5000,
        title="Keep settings versions",
        description="Older versions go only when there are more than this and they are over 30 days old. "
        "The current version always stays.",
    )

    @model_validator(mode="after")
    def _details_within_summaries(self) -> Retention:
        if self.artifacts_days > self.runs_days:
            raise ValueError("Keep run details must not be longer than Keep run summaries")
        return self


class Storage(Section):
    runs_db_max_mb: int = Field(
        default=300,
        ge=50,
        le=10000,
        title="runs.db size budget",
        description="Run details and logs. When the data exceeds this, the oldest days go first, whatever the "
        "retention below says (pinned runs stay).",
        json_schema_extra=ui(unit="MB"),
    )
    app_db_max_mb: int = Field(
        default=200,
        ge=50,
        le=10000,
        title="app.db size budget",
        description="Prices, forecasts, plans, measurements, cost-function plans and settings history. Backed up "
        "by Home Assistant. Oldest first too, but never the last days the planner needs.",
        json_schema_extra=ui(unit="MB"),
    )
    compact: Literal["auto", "manual"] = Field(
        default="auto",
        title="Compact databases",
        description="VACUUM rebuilds a file without its free pages. It needs free disk space of about the file's "
        "size and pauses the App for seconds to tens of seconds.",
        json_schema_extra=ui(
            labels={"auto": "After cleanup, when at least 20 % and 16 MiB are free", "manual": "Only with Compact now"}
        ),
    )
    backup_warn_days: int = Field(
        default=3,
        ge=0,
        le=60,
        title="Warn when no backup for",
        description="Health warns when the newest Home Assistant backup that contains EMHASS Lens is older than "
        "this. 0 turns the check off.",
        json_schema_extra=ui(unit="days"),
    )
    retention: Retention = Field(default=Retention(), title="Retention")


class Parity(Section):
    enabled: bool = Field(
        default=True,
        title="Compare with the HACS integration",
        description="While the old integration still runs, compare its prices and MPC payload with ours.",
    )
    legacy_prefix: str = Field(
        default="nordpool_ee_prices_",
        title="Legacy entity prefix",
        json_schema_extra=ui(advanced=True),
    )
    legacy_auto_mpc_switch: EntityId = Field(
        default="switch.nordpool_ee_prices_emhass_auto_mpc",
        title="Legacy Auto MPC switch",
        json_schema_extra=ui(widget="entity", domain="switch", advanced=True),
    )
    tolerance: float = Field(
        default=1e-6, ge=0, le=1, title="Tolerance", json_schema_extra=ui(unit="€/kWh", advanced=True)
    )


class InverterEntities(Section):
    charger_mode_select: EntityId = Field(
        default="select.sofar_charger_use_mode",
        title="Charger mode select",
        description="Control only acts while this is in passive mode.",
        json_schema_extra=ui(widget="entity", domain="select"),
    )
    passive_option: str = Field(default="Passive Mode", title="Passive mode option")
    enable_boolean: EntityId = Field(
        default="input_boolean.emhass_automation",
        title="Enabled when on",
        description="The same switch the automation uses (mFRR sessions turn it off).",
        json_schema_extra=ui(widget="entity", domain=["input_boolean", "switch"]),
    )
    state_select: EntityId = Field(
        default="input_select.emhass_passive_state",
        title="State select (for dashboards)",
        json_schema_extra=ui(widget="entity", domain="input_select"),
    )
    grid_power_number: EntityId = Field(
        default="number.sofar_passive_mode_grid_power",
        title="Passive grid power",
        json_schema_extra=ui(widget="entity", domain="number"),
    )
    battery_max_number: EntityId = Field(
        default="number.sofar_passive_mode_battery_power_max",
        title="Passive battery power max",
        json_schema_extra=ui(widget="entity", domain="number"),
    )
    battery_min_number: EntityId = Field(
        default="number.sofar_passive_mode_battery_power_min",
        title="Passive battery power min",
        json_schema_extra=ui(widget="entity", domain="number"),
    )
    apply_button: EntityId = Field(
        default="button.sofar_passive_mode_battery_charge_discharge",
        title="Apply passive settings button",
        json_schema_extra=ui(widget="entity", domain="button"),
    )
    feedin_number: EntityId = Field(
        default="number.sofar_feedin_max_power",
        title="Feed-in max power",
        json_schema_extra=ui(widget="entity", domain="number"),
    )
    feedin_button: EntityId = Field(
        default="button.sofar_feedin_limitation_mode",
        title="Apply feed-in limit button",
        json_schema_extra=ui(widget="entity", domain="button"),
    )


class InverterLimits(Section):
    battery_max_w: int = Field(
        default=20000, ge=0, le=100000, title="Battery discharge max", json_schema_extra=ui(unit="W")
    )
    battery_min_w: int = Field(
        default=-20000, ge=-100000, le=0, title="Battery charge max (negative)", json_schema_extra=ui(unit="W")
    )
    grid_import_max_w: int = Field(
        default=18800, ge=0, le=100000, title="Grid import max", json_schema_extra=ui(unit="W")
    )
    export_max_w: int = Field(
        default=15500, ge=0, le=100000, title="Export max (feed-in)", json_schema_extra=ui(unit="W")
    )
    export_only_battery_min_w: int = Field(
        default=-16000,
        ge=-100000,
        le=0,
        title="Battery min while exporting PV",
        json_schema_extra=ui(unit="W"),
    )
    force_charge_battery_min_w: int = Field(
        default=-3000,
        ge=-100000,
        le=0,
        title="Battery min while force charging",
        json_schema_extra=ui(unit="W"),
    )
    force_charge_grid_cap_above_w: int = Field(
        default=9000,
        ge=0,
        le=100000,
        title="Force charge: use the import max above",
        json_schema_extra=ui(unit="W"),
    )
    force_charge_grid_margin_w: int = Field(
        default=1000,
        ge=0,
        le=10000,
        title="Force charge: grid target margin",
        json_schema_extra=ui(unit="W"),
    )
    low_export_price: float = Field(
        default=0.03,
        title="Block export at or below this price",
        description="Feed-in 0 W and no PV-export mode when the slot's export price is at or below this "
        "(an unknown price counts as 0).",
        json_schema_extra=ui(unit="€/kWh"),
    )


class Inverter(Section):
    mode: Literal["off", "dry_run", "live"] = Field(
        default="off",
        title="Inverter control",
        description="Dry run: decide each slot and compare with what the automation did, without touching the "
        "inverter. Live: EMHASS Lens sets the inverter itself (turn the automation off first).",
        json_schema_extra=ui(labels={"off": "Off", "dry_run": "Dry run", "live": "Live"}),
    )
    decide_offset_s: int = Field(
        default=5,
        ge=0,
        lt=300,
        title="Decide at (seconds into each quarter)",
        description="Right after the plan is published (:02).",
        json_schema_extra=ui(unit="s", widget="quarter_offset"),
    )
    compare_offset_s: int = Field(
        default=45,
        ge=10,
        lt=600,
        title="Compare with the automation at",
        json_schema_extra=ui(unit="s", widget="quarter_offset"),
    )
    entities: InverterEntities = Field(
        default=InverterEntities(), title="Inverter entities", json_schema_extra=ui(advanced=True)
    )
    limits: InverterLimits = Field(default=InverterLimits(), title="Limits and thresholds")


class ChargerEntities(Section):
    charge_mode_select: EntityId = Field(
        default="input_select.ev_charge_mode",
        title="Charge mode select",
        description="Your helper with the options Manual, EMHASS and Excess Solar.",
        json_schema_extra=ui(widget="entity", domain="input_select"),
    )
    emhass_option: str = Field(default="EMHASS", title="Option for EMHASS mode")
    solar_option: str = Field(default="Excess Solar", title="Option for Excess Solar mode")
    target_soc_number: EntityId = Field(
        default="input_number.ev_target_soc",
        title="Target SoC",
        description="Charging stops when the car has been at or above this for a while; it is then set back to 100.",
        json_schema_extra=ui(widget="entity", domain="input_number"),
    )
    max_solar_current_number: EntityId = Field(
        default="input_number.ev_max_solar_current",
        title="Maximum current",
        description="Caps both modes.",
        json_schema_extra=ui(widget="entity", domain="input_number"),
    )
    charging_state_sensor: EntityId = Field(
        default="sensor.abb_terra_ac_charger_charging_state_raw",
        title="Charging state (raw)",
        description="0 unplugged, 1/2/5 plugged in or paused, 4 charging.",
        json_schema_extra=ui(widget="entity", domain="sensor"),
    )
    current_limit_number: EntityId = Field(
        default="number.abb_terra_ac_charger_charging_current_limit",
        title="Charging current limit",
        json_schema_extra=ui(widget="entity", domain="number"),
    )
    start_button: EntityId = Field(
        default="button.abb_terra_ac_charger_start_charging",
        title="Start charging button",
        json_schema_extra=ui(widget="entity", domain="button"),
    )
    stop_button: EntityId = Field(
        default="button.abb_terra_ac_charger_stop_charging",
        title="Stop charging button",
        json_schema_extra=ui(widget="entity", domain="button"),
    )
    car_soc_sensor: EntityId = Field(
        default="sensor.model_3_usable_battery_level",
        title="Car battery level",
        json_schema_extra=ui(widget="entity", domain="sensor"),
    )
    pv_power_sensor: EntityId = Field(
        default="sensor.sofar_pv_power_total_watt",
        title="PV power now",
        json_schema_extra=ui(widget="entity", domain="sensor"),
    )
    pv_potential_sensor: EntityId = Field(
        default="sensor.potential_pv_power_advanced",
        title="Potential PV power",
        description="Used instead of the measured PV when it is much higher (the inverter is curtailing).",
        json_schema_extra=ui(widget="entity", domain="sensor"),
    )
    house_load_sensor: EntityId = Field(
        default="sensor.sofar_active_power_load_sys_watt",
        title="House load",
        json_schema_extra=ui(widget="entity", domain="sensor"),
    )
    deferrable_sensor: EntityId = Field(
        default="sensor.p_deferrable0",
        title="EMHASS's EV power sensor",
        description="What publish-data writes for the EV. The stored plan is used when it isn't updated yet.",
        json_schema_extra=ui(widget="entity", domain="sensor"),
    )
    automation: EntityId = Field(
        default="",
        title="Home Assistant automation (interlock)",
        description="Live mode refuses to act while this automation is on, so the two never both drive the charger.",
        json_schema_extra=ui(widget="entity", domain="automation"),
    )


class ChargerLimits(Section):
    min_current_a: int = Field(default=6, ge=1, le=32, title="Minimum charging current", json_schema_extra=ui(unit="A"))
    max_current_a: int = Field(
        default=16,
        ge=1,
        le=64,
        title="Never set more than",
        description="A safety cap on what EMHASS Lens writes to the charger.",
        json_schema_extra=ui(unit="A"),
    )
    w_per_amp: int = Field(
        default=690,
        ge=100,
        le=1000,
        title="Watts per amp",
        description="3 phases × 230 V.",
        json_schema_extra=ui(unit="W/A", advanced=True),
    )
    pv_potential_gap_w: int = Field(
        default=2000,
        ge=0,
        le=50000,
        title="Use the potential PV above this gap",
        json_schema_extra=ui(unit="W", advanced=True),
    )
    pv_stale_s: int = Field(
        default=600,
        ge=0,
        le=3600,
        title="PV data counts as stale after",
        description="Excess Solar never raises the current on PV data older than this.",
        json_schema_extra=ui(unit="s", advanced=True),
    )
    soc_for_s: int = Field(
        default=300,
        ge=0,
        le=3600,
        title="Target SoC must hold for",
        json_schema_extra=ui(unit="s"),
    )
    compare_delay_s: int = Field(
        default=8,
        ge=1,
        le=60,
        title="Compare with the automation after",
        description="Dry run: how long after a decision to start reading what the automation did.",
        json_schema_extra=ui(unit="s", advanced=True),
    )
    compare_window_s: int = Field(
        default=20, ge=2, le=300, title="Comparison window", json_schema_extra=ui(unit="s", advanced=True)
    )
    soc_compare_window_s: int = Field(
        default=90,
        ge=2,
        le=600,
        title="Comparison window for the SoC stop",
        json_schema_extra=ui(unit="s", advanced=True),
    )


class PvReserve(Section):
    enabled: bool = Field(
        default=False,
        title="Reserve PV for Excess Solar charging",
        description="While the car charges from excess solar (charge mode Excess Solar, plugged in, below the target "
        "SoC), the PV forecast sent to EMHASS is reduced by what the charger is expected to take in each slot, so "
        "EMHASS does not plan the home battery or exports with energy the car will use. The expected draw follows "
        "the Excess Solar rule: the PV forecast minus the house load EMHASS forecasts, in whole amps, capped by the "
        "maximum current. Nothing changes in EMHASS or Manual mode.",
    )
    car_battery_kwh: float = Field(
        default=75.0,
        gt=0,
        le=300,
        title="Car battery capacity",
        description="Reserving stops once the energy from the car's level to its target is covered; the rest of "
        "the horizon gets the full PV forecast again.",
        json_schema_extra=ui(unit="kWh"),
    )


class Charger(Section):
    mode: Literal["off", "dry_run", "live"] = Field(
        default="off",
        title="EV charger control",
        description="Dry run: decide like the automation and compare with what it did, without touching the "
        "charger. Live: EMHASS Lens drives the charger itself (turn the automation off first).",
        json_schema_extra=ui(labels={"off": "Off", "dry_run": "Dry run", "live": "Live"}),
    )
    tick_offset_s: int = Field(
        default=55,
        ge=0,
        lt=60,
        title="Check every minute at (seconds)",
        description="Excess Solar and the SoC stop are evaluated every minute; 55 s is just before the "
        "automation's own minute tick, so dry-run comparisons read what it did.",
        json_schema_extra=ui(unit="s", advanced=True),
    )
    decide_offset_s: int = Field(
        default=8,
        ge=0,
        lt=300,
        title="EMHASS mode fallback at (seconds into each quarter)",
        description="Normally the decision follows the publish; this is the fallback.",
        json_schema_extra=ui(unit="s", widget="quarter_offset", advanced=True),
    )
    entities: ChargerEntities = Field(
        default=ChargerEntities(), title="Charger entities", json_schema_extra=ui(advanced=True)
    )
    limits: ChargerLimits = Field(default=ChargerLimits(), title="Limits and thresholds")
    pv_reserve: PvReserve = Field(default=PvReserve(), title="PV reserved for Excess Solar")


class MarketEntities(Section):
    source_sensor: EntityId = Field(
        default="sensor.qw_source",
        title="Market source",
        description="Who sends the command: kratt or fusebox (through Qilowatt).",
        json_schema_extra=ui(widget="entity", domain="sensor"),
    )
    mode_sensor: EntityId = Field(
        default="sensor.qw_mode", title="Market command", json_schema_extra=ui(widget="entity", domain="sensor")
    )
    powerlimit_sensor: EntityId = Field(
        default="sensor.qw_powerlimit", title="Commanded power", json_schema_extra=ui(widget="entity", domain="sensor")
    )
    soc_sensor: EntityId = Field(
        default="sensor.sofar_battery_capacity_1",
        title="Battery SoC",
        json_schema_extra=ui(widget="entity", domain="sensor"),
    )
    pv_sensor: EntityId = Field(
        default="sensor.sofar_pv_power_total_watt",
        title="PV power now",
        json_schema_extra=ui(widget="entity", domain="sensor"),
    )
    enable_boolean: EntityId = Field(
        default="input_boolean.qilowatt_automation",
        title="Enabled when on",
        json_schema_extra=ui(widget="entity", domain=["input_boolean", "switch"]),
    )
    session_select: EntityId = Field(
        default="input_select.qilowatt_session_state",
        title="Session state select",
        description="Mirrored in live mode (none / buy / sell) for dashboards and the Home Assistant automation "
        "kept as a fallback; followed in shadow mode.",
        json_schema_extra=ui(widget="entity", domain="input_select"),
    )
    ha_automation: EntityId = Field(
        default="",
        title="Home Assistant automation (interlock)",
        description="Live mode refuses to act while this automation is on, so the two never both drive the inverter.",
        json_schema_extra=ui(widget="entity", domain="automation"),
    )


class MarketThresholds(Section):
    enter_w: int = Field(
        default=1000, ge=0, le=50000, title="Start or flip a session at", json_schema_extra=ui(unit="W")
    )
    exit_w: int = Field(default=400, ge=0, le=50000, title="Continue a session down to", json_schema_extra=ui(unit="W"))
    cooldown_s: int = Field(default=180, ge=0, le=3600, title="Cooldown between writes", json_schema_extra=ui(unit="s"))
    big_change_w: int = Field(
        default=2500, ge=0, le=50000, title="Bypass the cooldown for changes of", json_schema_extra=ui(unit="W")
    )
    deadband_w: int = Field(default=300, ge=0, le=50000, title="Deadband", json_schema_extra=ui(unit="W"))
    deadband_pct: float = Field(default=0.15, ge=0, le=1, title="Deadband as a share of the target")
    min_soc: float = Field(default=10, ge=0, le=100, title="No selling below", json_schema_extra=ui(unit="%"))
    settle_s: float = Field(
        default=2,
        ge=0,
        le=30,
        title="Settle time",
        description="How long to wait after a command changes, so a burst of three sensor updates lands first.",
        json_schema_extra=ui(unit="s"),
    )
    unavailable_timeout_s: int = Field(
        default=300, ge=0, le=3600, title="End a session when the source is lost for", json_schema_extra=ui(unit="s")
    )
    low_pv_w: int = Field(
        default=100, ge=0, le=10000, title="PV counts as none below", json_schema_extra=ui(unit="W", advanced=True)
    )
    buy_cap_w: int = Field(default=18200, ge=0, le=100000, title="Buy: grid target cap", json_schema_extra=ui(unit="W"))
    sell_cap_w: int = Field(
        default=15500, ge=0, le=100000, title="Sell: grid and feed-in cap", json_schema_extra=ui(unit="W")
    )
    buy_modes: list[str] = Field(
        default_factory=lambda: ["buy", "mfrrdown", "frrdown"],
        title="Buy commands",
        json_schema_extra=ui(widget="json", advanced=True),
    )
    sell_modes: list[str] = Field(
        default_factory=lambda: ["sell", "mfrrup", "frrup"],
        title="Sell commands",
        json_schema_extra=ui(widget="json", advanced=True),
    )
    sources: list[str] = Field(
        default_factory=lambda: ["fusebox", "kratt"],
        title="Known sources",
        json_schema_extra=ui(widget="json", advanced=True),
    )


class Market(Section):
    mode: Literal["off", "shadow", "live"] = Field(
        default="off",
        title="Qilowatt market control",
        description="Shadow: decides on every command change and every minute and compares with what the Home "
        "Assistant automation did. Live: EMHASS Lens runs the sessions itself (disable the automation first).",
        json_schema_extra=ui(labels={"off": "Off", "shadow": "Shadow", "live": "Live"}),
    )
    reconcile_offset_s: int = Field(
        default=15,
        ge=0,
        lt=60,
        title="Reconcile every minute at (seconds)",
        description="15 s after the automation's own minute tick, so shadow comparisons read what it did.",
        json_schema_extra=ui(unit="s", advanced=True),
    )
    compare_delay_s: int = Field(
        default=12,
        ge=3,
        le=60,
        title="Compare with the automation after",
        json_schema_extra=ui(unit="s", advanced=True),
    )
    soc_low_for_s: int = Field(
        default=10, ge=0, le=300, title="Low SoC must hold for", json_schema_extra=ui(unit="s", advanced=True)
    )
    entities: MarketEntities = Field(
        default=MarketEntities(), title="Market entities", json_schema_extra=ui(advanced=True)
    )
    thresholds: MarketThresholds = Field(default=MarketThresholds(), title="Thresholds")


class ExternalControl(Section):
    enabled: bool = Field(
        default=False,
        title="Hold while a market session owns the inverter",
        description="While the entity below shows one of the busy values (e.g. a Qilowatt mFRR session), MPC runs "
        "are built but not sent, the plan isn't published and the inverter isn't touched. When the session ends, "
        "the plan is re-applied right away.",
    )
    entity: EntityId = Field(
        default="input_select.qilowatt_session_state",
        title="Session entity",
        json_schema_extra=ui(widget="entity", domain=["input_select", "sensor", "binary_sensor", "input_boolean"]),
    )
    busy_values: list[str] = Field(
        default_factory=lambda: ["buy", "sell"],
        title="Busy when the state is one of",
        description="Compared without regard to case.",
        json_schema_extra=ui(widget="json"),
    )
    handback_wait_s: int = Field(
        default=60,
        ge=0,
        le=300,
        title="Wait for the inverter hand-back",
        description="After the session ends, how long to wait for the inverter control's enable switch to come "
        "back on before giving up.",
        json_schema_extra=ui(unit="s"),
    )
    replan: bool = Field(
        default=False,
        title="Re-run MPC after a session",
        description="Off: the existing plan is re-applied, with at most one inverter write. On: MPC also runs "
        "again with the battery state after the session; the inverter follows that plan from the next slot.",
    )
    resume_delay_s: int = Field(
        default=15, ge=0, le=300, title="Delay before the re-run", json_schema_extra=ui(unit="s", advanced=True)
    )


class Settings(Section):
    emhass: Emhass = Field(default=Emhass(), title="EMHASS")
    inputs: Inputs = Field(default=Inputs(), title="Inputs")
    prices: Prices = Field(default=Prices(), title="Prices")
    forecast: Forecast = Field(default=Forecast(), title="Price forecast")
    pv: Pv = Field(default=Pv(), title="PV forecast")
    measurements: Measurements = Field(default=Measurements(), title="Measurements")
    outputs: Outputs = Field(default=Outputs(), title="Home Assistant outputs")
    health: Health = Field(default=Health(), title="Health")
    notifications: Notifications = Field(default=Notifications(), title="Notifications")
    logging: Logging = Field(default=Logging(), title="Logging")
    storage: Storage = Field(default=Storage(), title="Storage")
    parity: Parity = Field(default=Parity(), title="Parity with the HACS integration")
    inverter: Inverter = Field(default=Inverter(), title="Inverter control (experimental)")
    charger: Charger = Field(default=Charger(), title="EV charger control (experimental)")
    market: Market = Field(default=Market(), title="Qilowatt market control (experimental)")
    external_control: ExternalControl = Field(default=ExternalControl(), title="Market session hold (mFRR)")


@cache
def secret_paths() -> tuple[tuple[str, ...], ...]:
    """Paths of fields marked as secret in the schema (masked in API responses)."""
    paths: list[tuple[str, ...]] = []

    def walk(node: dict[str, Any], path: tuple[str, ...]) -> None:
        if node.get("ui", {}).get("widget") == "secret":
            paths.append(path)
        for key, child in (node.get("properties") or {}).items():
            walk(child, (*path, key))

    walk(inlined_schema(), ())
    return tuple(paths)


@cache
def inlined_schema() -> dict[str, Any]:
    """JSON schema of Settings with $refs inlined, so the UI can walk it without a resolver."""
    schema = Settings.model_json_schema()
    defs = schema.pop("$defs", {})

    def resolve(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                target = defs[node["$ref"].rsplit("/", 1)[-1]]
                merged = {**resolve(target), **{k: resolve(v) for k, v in node.items() if k != "$ref"}}
                return merged
            return {k: resolve(v) for k, v in node.items()}
        if isinstance(node, list):
            return [resolve(v) for v in node]
        return node

    return resolve(schema)
