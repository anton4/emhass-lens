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


class InputsSnapshot(BaseModel):
    taken_at: str | None
    prices: PricesSummary
    pv: PvSummary | None
    soc_init: Reading
    soc_final: Reading
    deferrable_loads: list[DeferrableDescription]
    issues: list[IssueOut]


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


class InverterStatus(BaseModel):
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


class ChargerStatus(BaseModel):
    mode: str
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
