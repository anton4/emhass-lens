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

// ---- Generated from the API's models ----

export type Reading = S['Reading']
export type DeferrableDescription = S['DeferrableDescription']
export type Issue = S['IssueOut']
export type InputsSnapshot = S['InputsSnapshot']
export type PricesSummary = S['PricesSummary']
export type PvSummary = S['PvSummary']
export type NordpoolDay = S['NordpoolDay']
export type NordpoolNext = S['NordpoolNext']
export type NordpoolStatus = S['NordpoolStatus']
export type ForecastProviderStatus = S['ForecastProviderStatus']
export type ForecastStatus = S['ForecastStatus']
export type PvStatus = S['PvStatus']
export type HaStatus = S['HaStatus']
export type LastBuild = S['LastBuild']
export type MpcStatus = S['MpcStatus']
export type EmhassCheck = S['EmhassCheck']
export type DiscoveryAttempt = S['DiscoveryAttempt']
export type ExplainSlot = S['ExplainSlot']
export type Derived = S['Derived']
export type DriverResult = S['DriverResult']
export type DriverRequest = S['DriverRequest']
export type MlRequest = S['MlRequest']
export type OutputsStatus = S['OutputsStatus']
/** The `emhass_lens_plan_published` event (also the `event` artifact of an emhass.publish run). */
export type PublishEvent = S['PublishEvent']
export type PlanPrice = S['PlanPrice']
export type InverterStatus = S['InverterStatus']
export type Agreement = S['Agreement']
export type InverterSettings = S['Inverter']
export type ChargerStatus = S['ChargerStatus']
export type ChargerSettings = S['Charger']
export type MarketStatus = S['MarketStatus']
export type MarketSession = S['MarketSession']
export type WearStats = S['WearStats']
export type MarketSettings = S['Market']
export type SklearnModel = S['EmhassMl']['sklearn_model']
export type SetupChecklist = S['SetupChecklist']
export type SetupStep = S['SetupStep']

// ---- Run artifacts: the API returns these as free-form JSON (see backend services/*.py) ----

/** The `explain` artifact of an emhass.mpc run. */
export interface ExplainArtifact {
  anchor: string | null
  rounding: string
  submitted_at: string | null
  derived: Derived
  slots: ExplainSlot[]
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

export type PlanRow = Record<string, unknown> & { timestamp?: string }
