"""Response models: they document the API and generate the frontend's TypeScript types."""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from emhass_lens.settings.model import Settings


class VersionInfo(BaseModel):
    version: str
    started_at: str


class ComponentStatus(BaseModel):
    status: str  # ok | warning | error | unknown | disabled
    detail: str | None = None


class ProblemInfo(BaseModel):
    key: str
    severity: str  # warning | error
    title: str
    detail: str | None = None
    hint: str | None = None
    link: str | None = None  # UI route, e.g. "#/inputs"
    since: str | None = None


class UpdateInfo(BaseModel):
    """A newer EMHASS Lens that Home Assistant can install (from the Supervisor)."""

    update_available: bool
    version_latest: str | None = None
    addon_path: str | None = None  # the App's page in Home Assistant, e.g. /hassio/addon/<slug>/info
    released_version: str | None = None  # on GitHub with its image built, not picked up by Home Assistant yet
    store_path: str | None = None  # Home Assistant's App store (⋮ → Check for updates)
    checked_at: str | None = None


class StatusInfo(BaseModel):
    version: str
    started_at: str
    safe_mode: bool
    under_supervisor: bool
    timezone: str
    emhass_mode: str
    settings_revision: int
    settings_errors: list[dict[str, str]]
    scheduler_running: bool
    writable: bool
    write_block_reason: str | None
    actor: str
    components: dict[str, ComponentStatus]
    problems: list[ProblemInfo]
    driver: str = "none"  # who drives EMHASS: app | legacy | both | none
    update: UpdateInfo | None = None


class LogEntry(BaseModel):
    id: int
    ts: str
    level: str
    component: str
    msg: str
    run_id: int | None = None
    job: str | None = None
    exc: str | None = None


class JobInfo(BaseModel):
    id: str
    title: str
    description: str
    trigger: str
    paused: bool
    running: bool
    next_run: str | None
    last_started: str | None
    last_finished: str | None
    last_outcome: str | None
    last_run_id: int | None
    grace_s: int


class RunStarted(BaseModel):
    job: JobInfo
    run_id: int | None  # None when the run was skipped because the job is still running


class RunSummary(BaseModel):
    id: int
    job: str
    trigger: str
    mode: str | None = None
    scheduled_at: str | None = None
    started_at: str
    finished_at: str | None = None
    duration_ms: int | None = None
    outcome: str
    summary: str | None = None
    error: str | None = None
    settings_rev: int | None = None
    pinned: int = 0


class RunTimelineCell(BaseModel):
    job: str
    bucket: int
    outcome: str
    count: int
    last_id: int


class RunTimeline(BaseModel):
    """Run counts per job, outcome and time bucket (bucket 0 starts at `since`), for the Runs page timeline."""

    since: str
    until: str
    bucket_s: int
    cells: list[RunTimelineCell]


class ArtifactInfo(BaseModel):
    id: int
    kind: str
    created_at: str
    size: int


class RunDetail(RunSummary):
    artifacts: list[ArtifactInfo]


class SettingsResponse(BaseModel):
    revision: int
    settings: Settings
    errors: list[dict[str, str]]
    writable: bool
    write_block_reason: str | None


class DiffEntry(BaseModel):
    path: str
    old: Any = None
    new: Any = None


class SaveResponse(BaseModel):
    revision: int
    diff: list[DiffEntry]


class Revision(BaseModel):
    id: int
    created_at: str
    actor: str | None
    source: str
    schema_version: int
    comment: str | None
    diff: list[DiffEntry]


class SettingsSaveRequest(BaseModel):
    base_revision: int | None = None
    settings: dict[str, Any]
    comment: str | None = None


class SettingsPatchRequest(BaseModel):
    base_revision: int | None = None
    changes: dict[str, Any]
    comment: str | None = None


class SecretRequest(BaseModel):
    path: str = Field(description="Dotted path of a secret setting, e.g. forecast.ee.api_key")


class SecretValue(BaseModel):
    path: str
    value: str


class RevertRequest(BaseModel):
    base_revision: int | None = None
    comment: str | None = None


class ImportRequest(BaseModel):
    base_revision: int | None = None
    yaml: str
    comment: str | None = None
    dry_run: bool = True


class ImportPreview(BaseModel):
    diff: list[DiffEntry]
    errors: list[dict[str, str]]
    revision: int | None = None


# --- Phase 1: prices, inputs, plan, EMHASS -------------------------------------------------------------


class PriceSlotOut(BaseModel):
    start: str
    end: str
    origin: str  # actual | forecast:<provider>
    period: str  # day | night | day_peak | holiday_peak
    reason: str
    spot: float
    margin: float
    renewable: float
    excise: float
    balancing: float
    supply_security: float
    network: float
    tariff_ex_vat: float
    vat: float
    import_price: float
    export_fees: float
    export_price: float


class PriceTariff(BaseModel):
    """What the tariff adds to the spot price (€/kWh, without VAT), as the price breakdown names it."""

    package: str
    margin: float
    renewable: float
    excise: float
    balancing: float
    supply_security: float
    network_day: float
    network_night: float
    network_day_peak: float | None = None
    network_holiday_peak: float | None = None
    night_window: str
    vat_pct: float
    export_margin: float
    export_balancing: float


class PricesResponse(BaseModel):
    timezone: str
    now: str
    package: str
    slots: list[PriceSlotOut]
    actual_end: str | None
    forecast_until: str | None
    gaps: list[list[str]]
    nordpool: NordpoolStatus
    forecast: ForecastStatus
    tariff: PriceTariff | None = None


class Reading(BaseModel):
    """One value read from Home Assistant (or a fallback) with where it came from."""

    name: str
    value: float | bool | None
    source: str
    raw: Any = None
    age_s: float | None = None
    transform: str | None = None
    issue: str | None = None
    explain: str


class DeferrableDescription(BaseModel):
    name: str
    nominal_power_w: int
    enabled: Reading
    operating_hours: Reading
    deadline_timesteps: Reading
    single_constant: Reading
    running: Reading | None = None


class IssueOut(BaseModel):
    level: str  # error | warning | info
    code: str
    message: str
    hint: str | None = None


class PricesSummary(BaseModel):
    slots: int
    actual: int
    forecast: int
    first: str | None
    end: str | None
    forecast_source: str


class PvSummary(BaseModel):
    field: str
    sensors_used: list[str]
    sensors_missing: list[str]
    slots_missing: int
    first_missing: str | None


class EvReserveOut(BaseModel):
    """PV kept out of the forecast sent to EMHASS because the EV takes it from excess solar."""

    active: bool
    why: str
    energy_needed_wh: float | None = None
    energy_reserved_wh: float = 0
    until: str | None = None
    max_w: float = 0
    slots: int = 0
    soc: float | None = None
    target_soc: float | None = None


class InputsSnapshot(BaseModel):
    taken_at: str | None
    prices: PricesSummary
    pv: PvSummary | None
    soc_init: Reading
    soc_final: Reading
    deferrable_loads: list[DeferrableDescription]
    issues: list[IssueOut]
    ev_reserve: EvReserveOut | None = None


class NordpoolDay(BaseModel):
    day: str
    state: str | None
    slots: int
    last_attempt: str | None
    last_success: str | None
    consecutive_errors: int
    not_published: bool
    http_status: int | None
    error: str | None
    resolution_min: int | None
    updated_at: str | None


class NordpoolNext(BaseModel):
    day: str
    due_at: str | None
    reason: str


class NordpoolStatus(BaseModel):
    area: str
    timezone: str
    days: list[NordpoolDay]
    next: list[NordpoolNext]


class ForecastProviderStatus(BaseModel):
    last_attempt: str | None
    last_success: str | None
    http_status: int | None
    error: str | None
    consecutive_errors: int
    points: int
    start: str | None
    end: str | None
    issued_at: str | None


class ForecastStatus(BaseModel):
    source: str
    providers: dict[str, ForecastProviderStatus]


class PvStatus(BaseModel):
    source: str
    field: str | None = None
    sensors_used: list[str] = []
    sensors_missing: list[str] = []
    slots: int | None = None
    start: str | None = None
    end: str | None = None


class HaStatus(BaseModel):
    configured: bool
    connected: bool
    connected_since: str | None
    disconnected_since: str | None
    ha_version: str | None
    time_zone: str | None
    last_error: str | None
    watched: int


class LastBuild(BaseModel):
    built_at: str | None
    anchor: str | None
    horizon: int
    run_id: int | None


class HoldStatus(BaseModel):
    """A market session (e.g. Qilowatt mFRR) owning the inverter: MPC sends, publishes and inverter writes wait."""

    enabled: bool
    busy: bool
    entity: str
    value: str | None
    since: str | None
    last_hold: dict[str, Any] | None
    last_resume: dict[str, Any] | None


class MpcStatus(BaseModel):
    mode: str
    auto: bool
    driver: str  # app | legacy | both | none
    legacy_driving: bool
    last_success_at: str | None
    last_build: LastBuild | None
    held: bool = False
    hold: HoldStatus | None = None


class InputsResponse(BaseModel):
    snapshot: InputsSnapshot
    pv: PvStatus
    forecast: ForecastStatus
    home_assistant: HaStatus
    mpc: MpcStatus


class PlanSnapshotOut(BaseModel):
    generated_at: str
    fetched_at: str
    driver: str
    run_id: int | None = None
    last_run: dict[str, Any] | None = None
    rows: list[dict[str, Any]]


class PlanPrice(BaseModel):
    start: str
    import_price: float
    export_price: float
    origin: str


class PlanResponse(BaseModel):
    available: bool
    timezone: str
    current: PlanSnapshotOut | None
    previous: PlanSnapshotOut | None
    current_row: dict[str, Any] | None
    columns: list[str]
    prices: list[PlanPrice]
    driver: str
    emhass_url: str | None
    # a plan older than this (Settings → Health → Plan is stale after) is too old to trust
    stale_after_s: int


class NowQuantity(BaseModel):
    key: str  # batt | grid | pv | load | soc
    plan: float | None = None
    # battery, grid: where the inverter settles with the load and PV now; soc: where it should be now
    expected: float | None = None
    measured: float | None = None
    entity: str | None = None
    age_s: float | None = None
    differs: bool | None = None  # None when either side is unknown, or for a forecast (house load, PV)
    sign_hint: bool = False  # battery: measured and expected run opposite ways (a sensor with the other sign?)


class InverterNow(BaseModel):
    mode: str
    in_control: bool
    reason: str | None = None
    charger_mode: str | None = None
    state: str | None = None
    grid_power_w: float | None = None
    battery_max_w: float | None = None
    battery_min_w: float | None = None
    feedin_max_w: float | None = None
    written_at: str | None = None
    run_id: int | None = None


class ChargerNow(BaseModel):
    current_limit_a: float | None = None
    state_raw: int | None = None
    power_w: float | None = None  # while charging its current limit in W (charger.limits.w_per_amp), else 0
    soc: float | None = None  # the car's battery level, %
    target_soc: float | None = None  # %
    # the charger entity power_w last changed from (the charging state, or the current limit while it charges)
    entity: str | None = None
    age_s: float | None = None  # seconds since that entity was last updated


class ControlNow(BaseModel):
    """What drives the inverter now: the EMHASS plan, or a Qilowatt market session."""

    mode: str  # emhass | market
    run_by: str | None = None  # market: app (EMHASS Lens runs the session) | automation (Home Assistant does)
    value: str | None = None  # market: buy / sell, or the session entity's state
    power_w: float | None = None  # the commanded power, when known
    source: str | None = None  # who sent the command (kratt, fusebox), when known
    since: str | None = None
    entity: str | None = None  # the session entity a hold follows
    watched: bool  # False: EMHASS Lens doesn't watch market sessions (no market control and no hold)


class PlanNow(BaseModel):
    """The plan row in force for the current quarter next to what is measured and set now."""

    slot_start: str
    slot_end: str
    published_at: str | None = None
    row: dict[str, Any] | None = None
    plan_generated_at: str | None = None
    plan_run_id: int | None = None
    next_start: str
    next_row: dict[str, Any] | None = None
    prev_start: str
    prev_row: dict[str, Any] | None = None
    prev_quantities: list[NowQuantity] = []  # the previous slot against its measured quarter-hour means
    quantities: list[NowQuantity]
    inverter: InverterNow | None = None
    charger: ChargerNow | None = None
    control: ControlNow | None = None
    soc_min: float | None = None  # EMHASS's battery_minimum_state_of_charge, 0–1
    soc_max: float | None = None  # EMHASS's battery_maximum_state_of_charge, 0–1


class PlannedValues(BaseModel):
    """What the plan in force said for a past slot (EMHASS's columns and signs)."""

    P_grid: float | None = None
    P_batt: float | None = None
    P_PV: float | None = None
    P_Load: float | None = None
    P_deferrable: float | None = None
    SOC: float | None = None  # 0–1


class ActualValues(BaseModel):
    """Measured quarter-hour means in EMHASS's signs (W), SOC 0–1."""

    grid: float | None = None
    batt: float | None = None
    pv: float | None = None
    load: float | None = None
    soc: float | None = None


class HistorySlot(BaseModel):
    start: str
    planned: PlannedValues
    planned_at: str | None = None  # generated_at of the plan the values come from
    actual: ActualValues


class QuantityAccuracy(BaseModel):
    quantity: str  # load | pv | soc | grid | batt
    unit: str  # W | %
    n: int
    coverage: float
    mae: float | None = None
    bias: float | None = None  # planned − actual
    rmse: float | None = None
    mape: float | None = None
    sign_suspect: bool = False


class AccuracyWindow(BaseModel):
    hours: int
    horizon: int  # slots of look-ahead the planned values were taken at
    quantities: list[QuantityAccuracy]


class PriceForecastAccuracy(BaseModel):
    provider: str
    lead_hours: int
    n: int
    mae: float | None = None  # c/kWh
    bias: float | None = None
    mape: float | None = None


class MeasurementQuantity(BaseModel):
    quantity: str
    entity_id: str
    last_slot: str | None = None
    last_value: float | None = None


class MeasurementStatus(BaseModel):
    configured: list[MeasurementQuantity]
    backfill_remaining_slots: int
    last_sample_at: str | None = None
    last_error: str | None = None


class PlanHistoryResponse(BaseModel):
    timezone: str
    now: str
    hours: int
    horizon: int
    slots: list[HistorySlot]
    prices: list[PlanPrice]  # the window's past prices, [window start, now)
    accuracy: list[AccuracyWindow]  # 24 h and 7 d
    price_forecast: PriceForecastAccuracy | None = None
    measurements: MeasurementStatus


class CostfunTotals(BaseModel):
    """Energy and money over a plan's horizon, computed the same way for every cost function."""

    slots: int
    hours: float
    import_kwh: float
    export_kwh: float
    import_cost_eur: float
    export_revenue_eur: float
    net_cost_eur: float  # positive = money out
    pv_kwh: float
    load_kwh: float
    self_consumption_kwh: float
    self_consumption_pct: float | None = None
    battery_charge_kwh: float
    battery_discharge_kwh: float
    soc_end: float | None = None
    emhass_cost_profit_eur: float | None = None  # Σ cost_profit, EMHASS's own sign (positive = profit)
    emhass_objective: float | None = None  # Σ of the cost_fun_* column EMHASS optimised
    emhass_objective_column: str | None = None


class CostfunResult(BaseModel):
    costfun: str  # profit | cost | self-consumption
    label: str
    live: bool  # the method in use; its plan is EMHASS's current plan
    optim_status: str | None = None
    duration_ms: int | None = None
    problem: str | None = None
    generated_at: str | None = None
    totals: CostfunTotals | None = None
    rows: list[dict[str, Any]]


class CostfunHistoryPoint(BaseModel):
    run_id: int | None = None
    compared_at: str
    anchor: str
    net_cost_eur: dict[str, float | None]
    emhass_objective: dict[str, float | None]


class CostfunCompareResponse(BaseModel):
    available: bool
    live_costfun: str
    live_source: str  # settings | emhass_config | assumed
    can_run: bool
    cannot_run_reason: str | None = None
    auto: bool  # compared on every live run
    timezone: str
    compared_at: str | None = None
    anchor: str | None = None
    run_id: int | None = None
    results: list[CostfunResult]
    history: list[CostfunHistoryPoint]


class TableStorage(BaseModel):
    name: str
    rows: int
    bytes: int | None = None  # from SQLite's dbstat; None when unavailable
    oldest: str | None = None


class VacuumResult(BaseModel):
    ran: bool
    reason: str | None = None
    duration_ms: int | None = None
    before_bytes: int | None = None
    after_bytes: int | None = None


class CleanupResult(BaseModel):
    at: str
    trigger: str
    duration_ms: int
    removed: dict[str, int]
    trimmed: dict[str, dict[str, int]]  # database → table → rows cut by the size budget
    vacuum: dict[str, VacuumResult]
    over_budget: list[str]
    summary: str


class CompactResult(BaseModel):
    at: str
    databases: dict[str, VacuumResult]


class DatabaseStorage(BaseModel):
    name: str
    backed_up: bool
    file_bytes: int
    wal_bytes: int
    page_size: int
    page_count: int
    freelist_pages: int
    data_bytes: int  # pages in use
    free_bytes: int  # free pages (reused by new writes; VACUUM gives them back to the disk)
    budget_bytes: int
    over_budget: bool
    tables: list[TableStorage]


class BackupStatus(BaseModel):
    available: bool  # the Supervisor let us list backups
    reason: str | None = None
    newest_at: str | None = None  # the newest backup that contains EMHASS Lens
    newest_name: str | None = None
    newest_type: str | None = None
    newest_size_mb: float | None = None
    count: int = 0
    stale: bool = False


class RestoreInfo(BaseModel):
    detected_at: str
    last_run_id: int
    backup_taken_at: str | None = None
    acknowledged: bool = False


class StorageOverview(BaseModel):
    data_dir: str
    disk_free_bytes: int
    disk_total_bytes: int
    measured_at: str
    dbstat: bool
    databases: list[DatabaseStorage]
    last_cleanup: CleanupResult | None = None
    last_compact: CompactResult | None = None
    backup: BackupStatus | None = None
    restored: RestoreInfo | None = None


class EmhassCheck(BaseModel):
    key: str
    title: str
    status: str  # ok | info | warning | error
    expected: str
    actual: str
    explanation: str


class DiscoveryAttempt(BaseModel):
    url: str
    ok: bool
    version: str | None = None
    error: str | None = None


class EmhassStatusOut(BaseModel):
    url: str | None
    url_source: str | None
    reachable: bool | None
    version: str | None
    last_error: str | None
    last_health_at: str | None
    unreachable_since: str | None
    busy_with: str | None = None
    busy_since: str | None = None
    method_ts_round: str
    config_at: str | None
    checks: list[EmhassCheck]
    checks_status: str
    health: dict[str, Any] | None
    discovery: list[DiscoveryAttempt]
    mpc: MpcStatus


class ProblemsResponse(BaseModel):
    active: list[ProblemInfo]
    history: list[dict[str, Any]]


class EntityOption(BaseModel):
    entity_id: str
    name: str | None
    state: str | None
    unit: str | None
    device_class: str | None


class ExplainSlot(BaseModel):
    i: int
    start: str
    origin: str
    period: str
    spot: float
    load_cost: float
    prod_price: float
    pv_w: float
    ev_reserved_w: float = 0
    export_max_w: float | None = None


class Derived(BaseModel):
    extend_days: int
    num_lags: int
    num_lags_formula: str
    historic_days_to_retrieve: int
    delta_forecast_daily: int


class MpcPreview(BaseModel):
    built_at: str
    anchor: str
    rounding: str
    mode: str
    payload: dict[str, Any]
    explain: list[ExplainSlot]
    validation: list[IssueOut]
    inputs: InputsSnapshot
    derived: Derived
    ev_reserve: EvReserveOut | None = None


class SentDeferrable(BaseModel):
    """One deferrable load as the payload had it, beside what its entities say it would ask for when on."""

    name: str
    on: bool
    nominal_power_w: float
    operating_hours: float
    end_timesteps: int  # from the anchor; 0 = no deadline, the whole horizon
    single_constant: bool
    configured_power_w: float | None = None
    configured_hours: float | None = None
    configured_end_timesteps: int | None = None
    enabled_source: str | None = None
    # the first timestep (from the anchor) it may run in, and whose it is: the payload's or EMHASS's config
    start_timesteps: int | None = None
    start_source: str | None = None  # payload | emhass_config


class SentModel(BaseModel):
    """How EMHASS forecasts the house load: its ML model and what it learns from."""

    method: str | None = None
    var_model: str | None = None
    num_lags: int | None = None
    historic_days: int | None = None


class MeasuredSlot(BaseModel):
    """One slot before the anchor: what was measured (W means, SOC 0–1) and the prices that applied (Nord Pool with
    the current tariff, rounded as a payload has them)."""

    start: str
    load: float | None = None
    pv: float | None = None
    soc: float | None = None
    load_cost: float | None = None
    prod_price: float | None = None
    period: str | None = None


class BeyondSlot(BaseModel):
    """One slot after the horizon, which wasn't sent: the price and PV forecast as they are now."""

    start: str
    origin: str  # actual | forecast:<provider>
    period: str
    load_cost: float
    prod_price: float
    pv_w: float | None = None  # None: Solcast has no value for it


class HorizonOption(BaseModel):
    """Where the plan would end with `days` of price forecast after the Nord Pool prices (Settings → Price forecast →
    Extend by), with the data there is now."""

    days: int
    end: str
    slots: int  # from the anchor
    num_lags: int  # EMHASS's load model then
    short: bool  # the forecast (or the maximum horizon) ends it before Nord Pool + `days`


class SentInputs(BaseModel):
    """What one MPC payload gave EMHASS slot by slot (the last run's, or one built now), the house load EMHASS
    forecast for those slots, what was measured before the anchor, and the forecasts after the horizon."""

    available: bool
    source: str  # last_run | preview
    timezone: str
    run_id: int | None
    run_outcome: str | None
    run_mode: str | None
    sent_at: str | None
    anchor: str | None
    slots: list[ExplainSlot]
    load_w: list[float | None]
    load_source: str  # plan | sent | none
    load_plan_generated_at: str | None
    load_plan_run_id: int | None
    soc_init: float | None
    soc_final: float | None
    soc_init_reading: Reading | None
    soc_final_reading: Reading | None
    model: SentModel | None
    deferrables: list[SentDeferrable]
    pv_sensors: int
    pv_slots_missing: int
    no_export_at_or_below: float | None
    measured: list[MeasuredSlot]
    measured_entities: dict[str, str]
    beyond: list[BeyondSlot] = []
    actual_end: str | None = None  # where the Nord Pool prices end
    forecast_source: str = "none"
    extend_days: int = 0  # the setting (0 without a price forecast)
    horizon_options: list[HorizonOption] = []
    # the battery's state-of-charge limits (0–1): the payload's, else EMHASS's config as it is now
    soc_min: float | None = None
    soc_max: float | None = None


class DriverResult(BaseModel):
    ok: bool
    run_id: int | None = None
    revision: int | None = None
    legacy_switch: str | None = None
    error: str | None = None


class DriverRequest(BaseModel):
    base_revision: int | None = None


class MlRequest(BaseModel):
    sklearn_model: str | None = None
    historic_days: int | None = None
    n_trials: int | None = None


class PublishedValues(BaseModel):
    """The current slot's plan values, EMHASS signs: battery + discharges / − charges, grid + imports / − exports."""

    p_batt_w: float | None = None
    p_grid_w: float | None = None
    p_pv_w: float | None = None
    p_pv_curtailment_w: float | None = None
    p_load_w: float | None = None
    soc_opt: float | None = None
    p_deferrable0_w: float | None = None
    p_deferrable1_w: float | None = None


class PublishedPrice(BaseModel):
    import_: float = Field(alias="import")
    export: float

    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)


class PublishEvent(BaseModel):
    """Data of the emhass_lens_plan_published event."""

    slot_start: str | None
    slot_end: str | None
    plan_generated_at: str | None
    run_id: int | None
    current: PublishedValues
    price: PublishedPrice | None = None


class OutputsStatus(BaseModel):
    enabled: bool
    connected: bool
    broker: str | None
    last_error: str | None
    last_event: PublishEvent | None
    last_published_at: str | None


class Agreement(BaseModel):
    hours: int
    compared: int
    agreed: int
    rate: float | None


class DriftStatus(BaseModel):
    """The minute check that sets back what something else changed."""

    enabled: bool
    checked_at: str | None = None
    corrections_1h: int = 0
    fighting: dict[str, Any] | None = None  # {field, since, count} while corrections are paused


class WearStats(BaseModel):
    """Presses of the Sofar apply and feed-in buttons (EEPROM wear), ours and anyone's."""

    hours: int
    apply_presses: int
    feedin_presses: int
    our_commits: int
    presses_not_ours: int
    last_apply_at: str | None
    last_feedin_at: str | None


class ButtonPress(BaseModel):
    """One press of a Sofar button, whoever pressed it."""

    at: str
    entity_id: str
    button: str | None  # apply | feedin; None for a button that is no longer configured
    source: str  # lens | automation | user | unknown
    run_id: int | None  # the EMHASS Lens run that pressed it
    owner: str | None = None  # ours: plan | market (who the run wrote for)


class InverterWrite(BaseModel):
    """One write EMHASS Lens made to the inverter: the passive settings or the feed-in limit, for the plan or for a
    market session."""

    at: str
    owner: str  # plan | market
    group: str  # passive | feedin
    grid_w: float | None = None
    battery_max_w: float | None = None
    battery_min_w: float | None = None
    feedin_w: float | None = None
    run_id: int | None = None
    ok: bool


class InverterActivity(BaseModel):
    """Every Sofar button press and every write EMHASS Lens made in a window, newest first."""

    presses: list[ButtonPress]
    writes: list[InverterWrite]


class InverterStatus(BaseModel):
    drift: DriftStatus | None = None
    mode: str
    last: dict[str, Any] | None
    last_compare: dict[str, Any] | None
    preconditions: str | None
    agreement_24h: Agreement
    agreement_7d: Agreement
    wear_24h: WearStats
    wear_7d: WearStats
    presses: list[ButtonPress]  # the last 7 days, newest first
    writes: list[InverterWrite] = []  # the last 24 h, newest first


class MarketSession(BaseModel):
    id: int
    direction: str
    source: str | None
    mode: str | None
    power_w: int | None
    started_at: str
    updated_at: str
    ended_at: str | None = None
    end_reason: str | None = None
    start_run_id: int | None = None  # the market run that opened it
    end_run_id: int | None = None


class MarketCommandSpan(BaseModel):
    start: str
    end: str
    direction: str  # buy | sell
    source: str
    mode: str
    power_w: int
    open: bool  # still on at the end of the window
    measured_w: int | None = None  # the grid power measured over it (EMHASS's sign: + import); None past 48 h
    measured_coverage: float | None = None  # 0–1: how much of it the grid sensor had a value for
    # the grid's mean (EMHASS's sign) over Market → Thresholds → Baseline before its session's first command; delivery
    # is judged from it. None past 48 h, without a sensor, or with the baseline at 0 s
    baseline_w: int | None = None


class MarketCommands(BaseModel):
    spans: list[MarketCommandSpan]
    error: str | None = None  # why the recorder history couldn't be read
    measured_error: str | None = None  # why the grid power over the commands couldn't be read


class GridPoint(BaseModel):
    t: str
    w: int | None  # W, EMHASS's sign (+ import, − export); None: the sensor had no value. Holds until the next point
    # When `w` is a bucket's mean (GridDetail.step_s set): the lowest and highest reading in the bucket, so a chart
    # can draw every spike; absent for a raw change
    lo: int | None = None
    hi: int | None = None


class GridDetail(BaseModel):
    """The measured grid power on [start, end): every change (step_s None) when they fit the point budget, else
    means per step_s with each bucket's lowest and highest reading, broken where a market command starts, ends or
    changes."""

    entity: str | None
    start: str
    end: str
    step_s: int | None
    points: list[GridPoint]
    error: str | None = None
    # older hours aren't in memory yet: the points cover what is, and the chart asks again shortly
    pending: bool | None = None


class WatchdogFinding(BaseModel):
    kind: str  # stale | long_session | emhass_off
    severity: str  # error | warning
    direction: str | None
    since: str | None
    age_s: int
    episode: str
    message: str


class MarketWatchdogStatus(BaseModel):
    """The session watchdog: the safety net next to the market control (the HA "Qilowatt: Session Watchdog")."""

    enabled: bool
    mode: str  # the market mode while the watchdog is on, else off
    stale_after_s: int
    long_session_s: int
    emhass_off_s: int
    checked_at: str | None
    findings: list[WatchdogFinding]
    last_action: dict[str, Any] | None  # {at, run_id, outcome, summary} of the last run that acted or reported


class MarketStatus(BaseModel):
    mode: str
    session: MarketSession | None
    last: dict[str, Any] | None
    last_compare: dict[str, Any] | None
    preconditions: str | None
    sensors: dict[str, Any]
    agreement_24h: Agreement
    agreement_7d: Agreement
    wear_24h: WearStats
    wear_7d: WearStats
    notice: str | None
    watchdog: MarketWatchdogStatus | None


class MarketReconcileRequest(BaseModel):
    trigger_entity: str | None = None
    force_end: bool = False  # live: end the open session whatever the command says


class SocTracking(BaseModel):
    since: str | None
    fired: bool
    due_at: str | None


class ChargeModeInfo(BaseModel):
    entity: str
    current: str | None = None
    options: list[str]
    emhass_option: str
    solar_option: str


class ChargeModeRequest(BaseModel):
    option: str


class ChargerStatus(BaseModel):
    drift: DriftStatus | None = None
    mode: str
    charge_mode: ChargeModeInfo | None = None
    pv_reserve: EvReserveOut | None = None
    last: dict[str, Any] | None
    last_compare: dict[str, Any] | None
    last_tick: dict[str, Any] | None
    soc: SocTracking
    preconditions: str | None
    agreement_24h: Agreement
    agreement_7d: Agreement


class SetupStep(BaseModel):
    key: str
    title: str
    state: str  # done | todo | attention | skipped
    detail: str
    link: str | None = None
    optional: bool = False


class SetupChecklist(BaseModel):
    steps: list[SetupStep]
    done: int
    total: int
