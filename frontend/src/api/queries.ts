import { useQuery } from '@tanstack/react-query'
import { api, query } from './client'
import type { JobInfo, Revision, RunDetail, RunSummary, SettingsResponse, StatusInfo, VersionInfo } from './types'
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
