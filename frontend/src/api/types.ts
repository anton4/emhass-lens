import type { components } from './schema'

type S = components['schemas']

export type StatusInfo = S['StatusInfo']
export type ComponentStatus = S['ComponentStatus']
export type VersionInfo = S['VersionInfo']
export type LogEntry = S['LogEntry']
export type JobInfo = S['JobInfo']
export type RunSummary = S['RunSummary']
export type RunDetail = S['RunDetail']
export type RunStarted = S['RunStarted']
export type ArtifactInfo = S['ArtifactInfo']
export type SettingsResponse = S['SettingsResponse']
export type SettingsDoc = S['Settings']
export type SaveResponse = S['SaveResponse']
export type Revision = S['Revision']
export type DiffEntry = S['DiffEntry']
export type ImportPreview = S['ImportPreview']
export type ProblemInfo = S['ProblemInfo']
export type ProblemsResponse = S['ProblemsResponse']
export type PriceSlot = S['PriceSlotOut']
export type PricesResponse = S['PricesResponse']
export type InputsResponse = S['InputsResponse']
export type PlanResponse = S['PlanResponse']
export type PlanSnapshot = S['PlanSnapshotOut']
export type EmhassStatus = S['EmhassStatusOut']
export type EntityOption = S['EntityOption']
export type MpcPreview = S['MpcPreview']
export type LegacyPreview = S['LegacyPreview']

export interface FieldError {
  loc: string
  msg: string
}

// ---- Shapes the backend returns inside free-form dicts (see backend services/*.py) ----

/** One value read from Home Assistant (services/inputs.py describe()). */
export interface Reading {
  name: string
  value: number | boolean | null
  source: string
  raw: unknown
  age_s: number | null
  transform: string | null
  issue: string | null
  explain: string
}

export interface DeferrableDescription {
  name: string
  nominal_power_w: number
  enabled: Reading
  operating_hours: Reading
  deadline_timesteps: Reading
  single_constant: Reading
}

export interface Issue {
  level: 'error' | 'warning' | 'info'
  code: string
  message: string
  hint: string | null
}

export interface InputsSnapshot {
  taken_at: string | null
  prices: {
    slots: number
    actual: number
    forecast: number
    first: string | null
    end: string | null
    forecast_source: string
  }
  pv: {
    field: string
    sensors_used: string[]
    sensors_missing: string[]
    slots_missing: number
    first_missing: string | null
  } | null
  soc_init: Reading
  soc_final: Reading
  deferrable_loads: DeferrableDescription[]
  issues: Issue[]
}

export interface ExplainSlot {
  i: number
  start: string
  origin: string
  period: string
  spot: number
  load_cost: number
  prod_price: number
  pv_w: number
}

export interface Derived {
  extend_days: number
  num_lags: number
  num_lags_formula: string
  historic_days_to_retrieve: number
  delta_forecast_daily: number
}

/** The `explain` artifact of an emhass.mpc run. */
export interface ExplainArtifact {
  anchor: string | null
  rounding: string
  submitted_at: string | null
  derived: Derived
  slots: ExplainSlot[]
}

export interface EmhassCheck {
  key: string
  title: string
  status: string
  expected: string
  actual: string
  explanation: string
}

export interface ParityExample {
  i: number
  slot: string | null
  ours: number
  legacy: number
  delta: number
}

export interface ParitySection {
  name: string
  ok: boolean
  explained?: string
  compared?: number
  equal?: number
  different?: number
  ours_len?: number
  legacy_len?: number
  legacy_slots_without_ours?: number
  examples?: ParityExample[]
  differences?: Record<string, unknown>[]
  explained_differences?: string[]
  legacy_run?: string | null
  our_build?: string | null
  our_run_id?: number | null
}

export interface ParityReport {
  checked_at: string | null
  ok: boolean
  sections: ParitySection[]
}

export interface NordpoolDay {
  day: string
  state: string | null
  slots: number
  last_attempt: string | null
  last_success: string | null
  consecutive_errors: number
  not_published: boolean
  http_status: number | null
  error: string | null
  resolution_min: number | null
  updated_at: string | null
}

export interface NordpoolStatus {
  area: string
  timezone: string
  days: NordpoolDay[]
  next: { day: string; due_at: string | null; reason: string }[]
}

export interface ForecastProviderStatus {
  last_attempt: string | null
  last_success: string | null
  http_status: number | null
  error: string | null
  consecutive_errors: number
  points: number
  start: string | null
  end: string | null
  issued_at: string | null
}

export interface ForecastStatus {
  source: string
  providers: Record<string, ForecastProviderStatus>
}

export interface PvStatus {
  source: string
  field?: string
  sensors_used?: string[]
  sensors_missing?: string[]
  slots?: number
  start?: string | null
  end?: string | null
}

export interface HaStatus {
  configured: boolean
  connected: boolean
  connected_since: string | null
  disconnected_since: string | null
  ha_version: string | null
  time_zone: string | null
  last_error: string | null
  watched: number
}

export interface MpcStatus {
  mode: string
  auto: boolean
  driver: string
  legacy_driving: boolean
  last_success_at: string | null
  last_build: { built_at: string | null; anchor: string | null; horizon: number; run_id: number | null } | null
}

export interface DiscoveryAttempt {
  url: string
  ok: boolean
  version?: string | null
  error?: string
}

export type PlanRow = Record<string, unknown> & { timestamp?: string }
