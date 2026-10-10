// Actions that change who drives EMHASS, the EMHASS mode, or run EMHASS's ML jobs. Each refreshes the
// queries whose answers it changes.

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { api } from './client'
import { keys } from './queries'
import type { ChargerStatus, DriverResult, MlRequest, RunStarted, SaveResponse, SettingsResponse, StorageOverview } from './types'

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

export type ControllerSection = 'inverter' | 'charger' | 'market'

/** Change an experimental controller's mode (inverter, charger: off | dry_run | live; market: off | shadow | live). */
export function useSetControllerMode(section: ControllerSection) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (mode: string) =>
      api.post<SaveResponse>('/api/settings/change', {
        base_revision: await baseRevision(queryClient),
        changes: { [section]: { mode } },
        comment: `${section === 'charger' ? 'EV charger' : section === 'market' ? 'Market' : 'Inverter'} mode ${mode.replace('_', ' ')} from its page`,
      }),
    onSettled: () => {
      refreshAfterChange(queryClient)
      void queryClient.invalidateQueries({ queryKey: keys[section] })
    },
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

/** Reconcile the market controller now; `force_end` ends the open session (live mode). Answers with the run id. */
export function useMarketReconcile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { force_end?: boolean }) => api.post<RunStarted>('/api/market/reconcile', body),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.market })
      void queryClient.invalidateQueries({ queryKey: keys.marketSessions })
      void queryClient.invalidateQueries({ queryKey: ['runs'] })
    },
  })
}

/** Decide for the EV charger now (applied only in live mode); answers with the run id. */
export function useChargerDecide() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<RunStarted>('/api/charger/decide', {}),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.charger })
      void queryClient.invalidateQueries({ queryKey: ['runs'] })
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

/** Start a scheduler job now, as its "Run now" button on Health does; answers with the run id. */
export function useRunJob() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (jobId: string) => api.post<RunStarted>(`/api/jobs/${encodeURIComponent(jobId)}/run`),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.jobs })
      void queryClient.invalidateQueries({ queryKey: ['runs'] })
    },
  })
}

/** Run the storage cleanup (retention, budgets, compaction when worthwhile) or a forced compaction now. */
export function useStorageAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (what: 'cleanup' | 'compact') =>
      api.post<RunStarted>(`/api/jobs/${what === 'cleanup' ? 'maintenance.retention' : 'maintenance.compact'}/run`, {}),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.storage })
      void queryClient.invalidateQueries({ queryKey: keys.jobs })
      void queryClient.invalidateQueries({ queryKey: ['runs'] })
    },
  })
}

/** Dismiss the "restored from a backup" note. */
export function useRestoreAck() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<StorageOverview>('/api/storage/restore-ack', {}),
    onSuccess: (data) => queryClient.setQueryData(keys.storage, data),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.problems }),
  })
}

/** Switch the EV charge-mode helper (Manual / EMHASS / Excess Solar) through Home Assistant. */
export function useChargeMode() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (option: string) => api.post<ChargerStatus>('/api/charger/mode', { option }),
    onSuccess: (data) => queryClient.setQueryData(keys.charger, data),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['runs'] }),
  })
}
