import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, query } from './client'
import type {
  ChargerStatus,
  CostfunCompareResponse,
  EmhassStatus,
  EntityOption,
  GridDetail,
  InputsResponse,
  InverterStatus,
  JobInfo,
  MarketCommands,
  MarketSession,
  MarketStatus,
  OutputsStatus,
  PlanHistoryResponse,
  PlanNow,
  PlanResponse,
  PricesResponse,
  ProblemsResponse,
  Revision,
  RunDetail,
  RunSummary,
  RunTimeline,
  SentInputs,
  SettingsResponse,
  SetupChecklist,
  StatusInfo,
  StorageOverview,
  VersionInfo,
} from './types'
import type { SchemaNode } from '../lib/schema'
import { isClosedRange } from '../lib/days'
import type { DetailRequest } from '../lib/gridDetail'

export const keys = {
  status: ['status'] as const,
  version: ['version'] as const,
  jobs: ['jobs'] as const,
  runs: (filters: Record<string, unknown>) => ['runs', filters] as const,
  closedRuns: (filters: Record<string, unknown>) => ['runs-closed', filters] as const,
  run: (id: number) => ['run', id] as const,
  settings: ['settings'] as const,
  schema: ['settings-schema'] as const,
  revisions: ['settings-revisions'] as const,
  plan: ['plan'] as const,
  planNow: ['plan-now'] as const,
  planHistory: (hours: number, horizon: number) => ['plan-history', hours, horizon] as const,
  costfun: ['costfun'] as const,
  storage: ['storage'] as const,
  prices: (daysBack: number) => ['prices', daysBack] as const,
  inputs: ['inputs'] as const,
  sentInputs: (hoursBack: number, beyond: boolean) => ['inputs', 'sent', hoursBack, beyond] as const,
  emhass: ['emhass'] as const,
  problems: ['problems'] as const,
  entities: (params: Record<string, unknown>) => ['ha-entities', params] as const,
  entity: (entityId: string) => ['ha-entity', entityId] as const,
  latestRun: (job: string) => ['runs', { job, limit: 1 }] as const,
  outputs: ['outputs'] as const,
  inverter: ['inverter'] as const,
  charger: ['charger'] as const,
  market: ['market'] as const,
  marketSessions: ['market-sessions'] as const,
  marketCommands: ['market-commands'] as const,
  gridDetail: ['grid-detail'] as const,
  setup: ['setup'] as const,
}

export function useStatus() {
  return useQuery({ queryKey: keys.status, queryFn: () => api.get<StatusInfo>('/api/status'), refetchInterval: 30_000 })
}

export function useVersion() {
  return useQuery({
    queryKey: keys.version,
    queryFn: () => api.get<VersionInfo>('/api/version'),
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
  })
}

export function useJobs() {
  return useQuery({ queryKey: keys.jobs, queryFn: () => api.get<JobInfo[]>('/api/jobs'), refetchInterval: 60_000 })
}

/** `job` and `outcome` keep any of several values, `not_job` and `not_outcome` leave them out. */
export type RunFilters = {
  job?: string | readonly string[]
  outcome?: string | readonly string[]
  not_job?: readonly string[]
  not_outcome?: readonly string[]
  limit?: number
  before?: number
  after?: number
  since?: string
  until?: string
  order?: 'asc' | 'desc'
  /** inverter: only the runs that wrote to the inverter (the plan's and the market's) */
  wrote?: 'inverter'
}

/** Runs matching `filters`. A range that ended a while ago no longer changes, so it sits under its own key that run
 * events don't reload (pinning a run reloads it). */
export function useRuns(filters: RunFilters) {
  const closed = isClosedRange(filters.until)
  return useQuery({
    queryKey: closed ? keys.closedRuns(filters) : keys.runs(filters),
    queryFn: () => api.get<RunSummary[]>(`/api/runs${query(filters)}`),
    ...(closed ? { staleTime: Infinity } : {}),
  })
}

/** Run counts per job, outcome and time bucket for the Runs timeline. Its key starts with "runs", so every run event
 * refreshes it like the list. */
export function useRunTimeline(since: string, until: string, bucketS: number) {
  return useQuery({
    queryKey: ['runs', 'timeline', since, until, bucketS] as const,
    queryFn: () => api.get<RunTimeline>(`/api/runs/timeline${query({ since, until, bucket_s: bucketS })}`),
    placeholderData: keepPreviousData,
  })
}

/** One run; a running one is followed every 3 s, so it finishes on screen even without the live stream. */
export function useRun(id: number) {
  return useQuery({
    queryKey: keys.run(id),
    queryFn: () => api.get<RunDetail>(`/api/runs/${id}`),
    refetchInterval: (q) => (q.state.data?.outcome === 'running' ? 3000 : false),
  })
}

export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: () => api.get<SettingsResponse>('/api/settings') })
}

export function useSettingsSchema() {
  return useQuery({
    queryKey: keys.schema,
    queryFn: () => api.get<SchemaNode>('/api/settings/schema'),
    staleTime: Infinity,
  })
}

export function useRevisions() {
  return useQuery({ queryKey: keys.revisions, queryFn: () => api.get<Revision[]>('/api/settings/revisions?limit=100') })
}

export function usePlan() {
  return useQuery({ queryKey: keys.plan, queryFn: () => api.get<PlanResponse>('/api/plan'), refetchInterval: 60_000 })
}

/** The plan row in force for this quarter, what is measured now and what the inverter is set to. */
export function usePlanNow() {
  return useQuery({ queryKey: keys.planNow, queryFn: () => api.get<PlanNow>('/api/plan/now'), refetchInterval: 10_000 })
}

/** Both databases: sizes, budgets, tables, the last cleanup and compaction, backups and restores. */
export function useStorage() {
  return useQuery({ queryKey: keys.storage, queryFn: () => api.get<StorageOverview>('/api/storage'), refetchInterval: 60_000 })
}

/** The newest comparison of EMHASS's three cost functions, and a week of their totals. */
export function useCostfun() {
  return useQuery({
    queryKey: keys.costfun,
    queryFn: () => api.get<CostfunCompareResponse>('/api/plan/costfun'),
    refetchInterval: 60_000,
  })
}

/** The last `hours` of slots: measured values and what the plan said `horizon` slots ahead of each. */
export function usePlanHistory(hours: number, horizon: number) {
  return useQuery({
    queryKey: keys.planHistory(hours, horizon),
    queryFn: () => api.get<PlanHistoryResponse>(`/api/plan/history${query({ hours, horizon })}`),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  })
}

export function usePrices(daysBack = 1) {
  return useQuery({
    queryKey: keys.prices(daysBack),
    queryFn: () => api.get<PricesResponse>(`/api/prices${query({ days_back: daysBack })}`),
    refetchInterval: 5 * 60_000,
  })
}

export function useInputs() {
  return useQuery({ queryKey: keys.inputs, queryFn: () => api.get<InputsResponse>('/api/inputs'), refetchInterval: 30_000 })
}

/** What the newest MPC run gave EMHASS, slot by slot, after `hoursBack` hours measured before its anchor. */
export function useSentInputs(hoursBack: number, beyond: boolean) {
  return useQuery({
    queryKey: keys.sentInputs(hoursBack, beyond),
    queryFn: () => api.get<SentInputs>(`/api/inputs/sent${query({ hours_back: hoursBack, beyond })}`),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  })
}

export function useEmhass() {
  return useQuery({ queryKey: keys.emhass, queryFn: () => api.get<EmhassStatus>('/api/emhass'), refetchInterval: 30_000 })
}

export function useProblems() {
  return useQuery({ queryKey: keys.problems, queryFn: () => api.get<ProblemsResponse>('/api/problems'), refetchInterval: 60_000 })
}

/** Home Assistant entities matching `q` in the given domains, best first (for the entity picker). */
export function useEntitySearch(domains: string[], q: string, limit: number, enabled: boolean) {
  const params = { domain: domains.join(','), q, limit }
  return useQuery({
    queryKey: keys.entities(params),
    queryFn: () => api.get<EntityOption[]>(`/api/ha/entities${query(params)}`),
    enabled,
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
  })
}

/** One entity by id, or null when Home Assistant doesn't have it (any domain). */
export function useEntity(entityId: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.entity(entityId),
    queryFn: async () => {
      const found = await api.get<EntityOption[]>(`/api/ha/entities${query({ q: entityId, limit: 1 })}`)
      return found.find((e) => e.entity_id === entityId) ?? null
    },
    enabled: enabled && entityId !== '',
    staleTime: 30_000,
    retry: false,
  })
}

/** The newest run of a job (or undefined while there is none). */
export function useLatestRun(job: string) {
  return useQuery({
    queryKey: keys.latestRun(job),
    queryFn: async () => (await api.get<RunSummary[]>(`/api/runs${query({ job, limit: 1 })}`))[0] ?? null,
  })
}

/** MQTT entities and the last plan-published event. */
export function useOutputs() {
  return useQuery({ queryKey: keys.outputs, queryFn: () => api.get<OutputsStatus>('/api/outputs'), refetchInterval: 30_000 })
}

/** Inverter control: mode, preconditions, the last decision and comparison, agreement. */
export function useInverter() {
  return useQuery({ queryKey: keys.inverter, queryFn: () => api.get<InverterStatus>('/api/inverter'), refetchInterval: 30_000 })
}

/** EV charger control: mode, preconditions, the last decision, comparison and minute check, agreement. */
export function useCharger() {
  return useQuery({ queryKey: keys.charger, queryFn: () => api.get<ChargerStatus>('/api/charger'), refetchInterval: 30_000 })
}

/** Qilowatt market control: mode, the session, the last decision and comparison, agreement, inverter wear. */
export function useMarket() {
  return useQuery({ queryKey: keys.market, queryFn: () => api.get<MarketStatus>('/api/market'), refetchInterval: 10_000 })
}

/** Market sessions newest first: the latest 50, or those started within [since, until). A past range stops
 * polling once none of its sessions is still open. */
export function useMarketSessions(range: { since?: string; until?: string } = {}) {
  const filters = range.since ? { ...range, limit: 500 } : { limit: 50 }
  const closed = isClosedRange(range.until)
  return useQuery({
    queryKey: [...keys.marketSessions, filters],
    queryFn: () => api.get<MarketSession[]>(`/api/market/sessions${query(filters)}`),
    refetchInterval: (q) => (closed && !q.state.data?.some((s) => !s.ended_at) ? false : 30_000),
  })
}

/** The grid power measured finer than the quarter-hour means (see lib/gridDetail `detailRequest` for the window). */
export function useGridDetail(req: DetailRequest | null, enabled: boolean) {
  const live = req?.until === null
  return useQuery({
    queryKey: [...keys.gridDetail, req?.since, req?.until ?? 'live', req?.maxPoints],
    queryFn: () =>
      api.get<GridDetail>(
        `/api/measurements/grid${query({ since: req?.since, until: req?.until, max_points: req?.maxPoints })}`,
      ),
    enabled: enabled && req !== null,
    placeholderData: keepPreviousData,
    refetchInterval: live ? 60_000 : false,
    staleTime: live ? 0 : Infinity,
  })
}

/** Qilowatt's commands since `since` (round it, so the key stays put), read from the Home Assistant recorder. */
export function useMarketCommands(since: string | null) {
  return useQuery({
    queryKey: [...keys.marketCommands, since],
    queryFn: () => api.get<MarketCommands>(`/api/market/commands${query({ since: since ?? undefined })}`),
    enabled: since !== null,
    refetchInterval: 60_000,
  })
}

export function useSetup() {
  return useQuery({ queryKey: keys.setup, queryFn: () => api.get<SetupChecklist>('/api/setup'), refetchInterval: 30_000 })
}
