import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, query } from './client'
import type {
  ChargerStatus,
  CostfunCompareResponse,
  EmhassStatus,
  EntityOption,
  InputsResponse,
  InverterStatus,
  JobInfo,
  LegacyPreview,
  MarketSession,
  MarketStatus,
  OutputsStatus,
  PlanHistoryResponse,
  PlanResponse,
  PricesResponse,
  ProblemsResponse,
  Revision,
  RunDetail,
  RunSummary,
  SettingsResponse,
  SetupChecklist,
  StatusInfo,
  StorageOverview,
  VersionInfo,
} from './types'
import type { SchemaNode } from '../lib/schema'

export const keys = {
  status: ['status'] as const,
  version: ['version'] as const,
  jobs: ['jobs'] as const,
  runs: (filters: Record<string, unknown>) => ['runs', filters] as const,
  run: (id: number) => ['run', id] as const,
  settings: ['settings'] as const,
  schema: ['settings-schema'] as const,
  revisions: ['settings-revisions'] as const,
  plan: ['plan'] as const,
  planHistory: (hours: number, horizon: number) => ['plan-history', hours, horizon] as const,
  costfun: ['costfun'] as const,
  storage: ['storage'] as const,
  prices: (daysBack: number) => ['prices', daysBack] as const,
  inputs: ['inputs'] as const,
  emhass: ['emhass'] as const,
  problems: ['problems'] as const,
  entities: (params: Record<string, unknown>) => ['ha-entities', params] as const,
  entity: (entityId: string) => ['ha-entity', entityId] as const,
  legacy: ['legacy-preview'] as const,
  latestRun: (job: string) => ['runs', { job, limit: 1 }] as const,
  outputs: ['outputs'] as const,
  inverter: ['inverter'] as const,
  charger: ['charger'] as const,
  market: ['market'] as const,
  marketSessions: ['market-sessions'] as const,
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

export function useRuns(filters: { job?: string; outcome?: string; limit?: number; before?: number }) {
  return useQuery({
    queryKey: keys.runs(filters),
    queryFn: () => api.get<RunSummary[]>(`/api/runs${query(filters)}`),
  })
}

export function useRun(id: number) {
  return useQuery({ queryKey: keys.run(id), queryFn: () => api.get<RunDetail>(`/api/runs/${id}`) })
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

export function useLegacyPreview(enabled = true) {
  return useQuery({
    queryKey: keys.legacy,
    queryFn: () => api.get<LegacyPreview>('/api/legacy/preview'),
    staleTime: 60_000,
    retry: false,
    enabled,
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

export function useMarketSessions() {
  return useQuery({
    queryKey: keys.marketSessions,
    queryFn: () => api.get<MarketSession[]>('/api/market/sessions?limit=50'),
    refetchInterval: 30_000,
  })
}

export function useSetup() {
  return useQuery({ queryKey: keys.setup, queryFn: () => api.get<SetupChecklist>('/api/setup'), refetchInterval: 30_000 })
}
