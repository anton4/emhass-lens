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


class NowQuantity(BaseModel):
    key: str  # batt | grid | pv | load | soc
    plan: float | None = None
    expected: float | None = None  # soc: where the plan expects it at this moment of the slot
    measured: float | None = None
    entity: str | None = None
    age_s: float | None = None
    differs: bool | None = None  # None when either side is unknown


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
    quantities: list[NowQuantity]
    inverter: InverterNow | None = None
    charger: ChargerNow | None = None


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
    pv_p10_w: float | None = None
    ev_reserved_w: float = 0


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


class LegacyPreview(BaseModel):
    found: bool
    changes: dict[str, Any]
    notes: list[str]
    diff: list[DiffEntry]
    errors: list[dict[str, str]]


class LegacyApplyRequest(BaseModel):
    base_revision: int | None = None


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


class InverterStatus(BaseModel):
    drift: DriftStatus | None = None
    mode: str
    last: dict[str, Any] | None
    last_compare: dict[str, Any] | None
    preconditions: str | None
    agreement_24h: Agreement
    agreement_7d: Agreement


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


class WearStats(BaseModel):
    """Presses of the Sofar apply and feed-in buttons (EEPROM wear), ours and anyone's."""

    hours: int
    apply_presses: int
    feedin_presses: int
    our_commits: int
    presses_not_ours: int
    last_apply_at: str | None
    last_feedin_at: str | None


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
