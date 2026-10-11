import { useQuery } from '@tanstack/react-query'
import { api } from './client'

/** A run's artifact by kind; artifacts never change, so it is fetched once. */
export function artifactQuery<T>(runId: number, kind: string, enabled = true) {
  return {
    queryKey: ['artifact', runId, kind] as const,
    queryFn: () => api.get<T>(`/api/runs/${runId}/artifacts/${encodeURIComponent(kind)}`),
    enabled,
    staleTime: Infinity,
  }
}

export function useArtifact<T>(runId: number, kind: string, enabled: boolean) {
  return useQuery(artifactQuery<T>(runId, kind, enabled))
}
