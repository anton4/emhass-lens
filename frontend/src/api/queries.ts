import { useQuery } from '@tanstack/react-query'
import { api, query } from './client'
import type {
  EmhassStatus,
  EntityOption,
  InputsResponse,
  JobInfo,
  LegacyPreview,
  OutputsStatus,
  PlanResponse,
  PricesResponse,
  ProblemsResponse,
  Revision,
  RunDetail,
  RunSummary,
  SettingsResponse,
  StatusInfo,
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
  prices: (daysBack: number) => ['prices', daysBack] as const,
  inputs: ['inputs'] as const,
  emhass: ['emhass'] as const,
  problems: ['problems'] as const,
  entities: (domains: string) => ['ha-entities', domains] as const,
  legacy: ['legacy-preview'] as const,
  latestRun: (job: string) => ['runs', { job, limit: 1 }] as const,
  outputs: ['outputs'] as const,
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

/** Entities for a picker; `domains` like "sensor,input_number" (empty = all). */
export function useEntities(domains: string, enabled = true) {
  return useQuery({
    queryKey: keys.entities(domains),
    queryFn: () => api.get<EntityOption[]>(`/api/ha/entities${query({ domain: domains, limit: 2000 })}`),
    staleTime: 30_000,
    retry: false,
    enabled,
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
