// Actions that change who drives EMHASS, the EMHASS mode, or run EMHASS's ML jobs. Each refreshes the
// queries whose answers it changes.

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { api } from './client'
import { keys } from './queries'
import type { DriverResult, MlRequest, RunStarted, SaveResponse, SettingsResponse } from './types'

async function baseRevision(queryClient: QueryClient): Promise<number> {
  const settings = await queryClient.fetchQuery({
    queryKey: keys.settings,
    queryFn: () => api.get<SettingsResponse>('/api/settings'),
    staleTime: 0,
  })
  return settings.revision
}

function refreshAfterChange(queryClient: QueryClient) {
  for (const key of [keys.settings, keys.status, keys.emhass, keys.jobs, keys.revisions, keys.outputs, keys.problems]) {
    void queryClient.invalidateQueries({ queryKey: key })
  }
  void queryClient.invalidateQueries({ queryKey: ['runs'] })
}

/** Turn the HACS integration's Auto MPC off and make EMHASS Lens drive EMHASS (live, Auto MPC on). */
export function useTakeOver() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () =>
      api.post<DriverResult>('/api/driver/take-over', { base_revision: await baseRevision(queryClient) }),
    onSettled: () => refreshAfterChange(queryClient),
  })
}

/** Put EMHASS Lens in dry run and turn the HACS integration's Auto MPC back on. */
export function useHandBack() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () =>
      api.post<DriverResult>('/api/driver/hand-back', { base_revision: await baseRevision(queryClient) }),
    onSettled: () => refreshAfterChange(queryClient),
  })
}

export type EmhassMode = 'off' | 'dry_run' | 'live'

/** Change the EMHASS mode (a settings revision like any other). */
export function useSetMode() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (mode: EmhassMode) =>
      api.post<SaveResponse>('/api/settings/change', {
        base_revision: await baseRevision(queryClient),
        changes: { emhass: { mode } },
        comment: `EMHASS mode ${mode.replace('_', ' ')} from the header switch`,
      }),
    onSettled: () => refreshAfterChange(queryClient),
  })
}

export type MlAction = 'fit' | 'tune' | 'predict'

/** Start an EMHASS ML job; answers with its run id. */
export function useMlAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ action, params }: { action: MlAction; params: MlRequest }) =>
      api.post<RunStarted>(`/api/ml/${action}`, params),
    onSettled: (_data, _error, { action }) => {
      void queryClient.invalidateQueries({ queryKey: keys.latestRun(`ml.${action}`) })
      void queryClient.invalidateQueries({ queryKey: keys.jobs })
    },
  })
}

/** Decide the inverter settings for the current slot now (applied only in live mode); answers with the run id. */
export function useInverterDecide() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<RunStarted>('/api/inverter/decide', {}),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.inverter })
      void queryClient.invalidateQueries({ queryKey: ['runs'] })
    },
  })
}
