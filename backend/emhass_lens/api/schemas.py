"""Response models: they document the API and generate the frontend's TypeScript types."""

from typing import Any

from pydantic import BaseModel

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
    nordpool: dict[str, Any]
    forecast: dict[str, Any]


class InputsResponse(BaseModel):
    snapshot: dict[str, Any]
    pv: dict[str, Any]
    forecast: dict[str, Any]
    home_assistant: dict[str, Any]
    mpc: dict[str, Any]


class PlanSnapshotOut(BaseModel):
    generated_at: str
    fetched_at: str
    driver: str
    run_id: int | None = None
    last_run: dict[str, Any] | None = None
    rows: list[dict[str, Any]]


class PlanResponse(BaseModel):
    available: bool
    current: PlanSnapshotOut | None
    previous: PlanSnapshotOut | None
    current_row: dict[str, Any] | None
    columns: list[str]
    prices: list[dict[str, Any]]
    driver: str
    emhass_url: str | None


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
    checks: list[dict[str, Any]]
    checks_status: str
    health: dict[str, Any] | None
    discovery: list[dict[str, Any]]
    mpc: dict[str, Any]


class ProblemsResponse(BaseModel):
    active: list[ProblemInfo]
    history: list[dict[str, Any]]


class EntityOption(BaseModel):
    entity_id: str
    name: str | None
    state: str | None
    unit: str | None
    device_class: str | None


class MpcPreview(BaseModel):
    built_at: str
    anchor: str
    rounding: str
    mode: str
    payload: dict[str, Any]
    explain: list[dict[str, Any]]
    validation: list[dict[str, Any]]
    inputs: dict[str, Any]
    derived: dict[str, Any]


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


class OutputsStatus(BaseModel):
    enabled: bool
    connected: bool
    broker: str | None
    last_error: str | None
    last_event: dict[str, Any] | None
    last_published_at: str | None
