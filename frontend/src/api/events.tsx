// One EventSource for the whole UI. It multiplexes server events, keeps TanStack queries fresh
// and hands log lines to whoever listens (the Logs page). If the stream keeps failing (some
// proxies buffer event streams) the UI falls back to polling.

import { useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { apiUrl } from './client'
import { keys } from './queries'
import type { LogEntry } from './types'

export type StreamState = 'connecting' | 'live' | 'reconnecting' | 'polling'

type LogListener = (entry: LogEntry) => void

interface EventsContextValue {
  state: StreamState
  subscribeLogs: (listener: LogListener) => () => void
}

const EventsContext = createContext<EventsContextValue>({
  state: 'connecting',
  subscribeLogs: () => () => {},
})

const TOPICS = 'log,run,job,settings,plan,problem,ha'
const MAX_FAILURES_BEFORE_POLLING = 5
const POLL_MS = 10_000

/** Which cached data a finished job may have changed. */
// eslint-disable-next-line react-refresh/only-export-components
export function familiesForJob(job: string): string[] {
  if (job === 'emhass.plan_watch' || job === 'emhass.mpc') return ['plan', 'emhass', 'outputs']
  if (job === 'emhass.publish') return ['plan', 'outputs']
  if (job === 'nordpool.poll' || job.startsWith('forecast.')) return ['prices']
  if (job.startsWith('emhass.')) return ['emhass']
  if (job.startsWith('driver.')) return ['settings', 'emhass', 'outputs']
  if (job.startsWith('ml.') || job === 'health.evaluate') return ['problems']
  if (job.startsWith('inverter.')) return ['inverter']
  if (job.startsWith('charger.')) return ['charger']
  return []
}

export function EventsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [state, setState] = useState<StreamState>('connecting')
  const listeners = useRef(new Set<LogListener>())

  useEffect(() => {
    let source: EventSource | null = null
    let failures = 0
    let retryTimer: number | undefined
    let pollTimer: number | undefined
    let invalidateTimer: number | undefined
    let closed = false
    const pending = new Set<string>()

    // Coalesce bursts (a run emits several events) into one refetch per query family.
    const invalidate = (family: string) => {
      pending.add(family)
      if (invalidateTimer !== undefined) return
      invalidateTimer = window.setTimeout(() => {
        invalidateTimer = undefined
        for (const name of pending) {
          if (name === 'runs') {
            void queryClient.invalidateQueries({ queryKey: ['runs'] })
            void queryClient.invalidateQueries({ queryKey: ['run'] })
          } else if (name === 'jobs') {
            void queryClient.invalidateQueries({ queryKey: keys.jobs })
          } else if (name === 'settings') {
            void queryClient.invalidateQueries({ queryKey: keys.settings })
            void queryClient.invalidateQueries({ queryKey: keys.revisions })
            void queryClient.invalidateQueries({ queryKey: keys.status })
            void queryClient.invalidateQueries({ queryKey: ['prices'] })
            void queryClient.invalidateQueries({ queryKey: keys.inputs })
            void queryClient.invalidateQueries({ queryKey: keys.emhass })
            void queryClient.invalidateQueries({ queryKey: keys.outputs })
            void queryClient.invalidateQueries({ queryKey: keys.inverter })
            void queryClient.invalidateQueries({ queryKey: keys.charger })
          } else if (name === 'inverter') {
            void queryClient.invalidateQueries({ queryKey: keys.inverter })
          } else if (name === 'charger') {
            void queryClient.invalidateQueries({ queryKey: keys.charger })
          } else if (name === 'plan') {
            void queryClient.invalidateQueries({ queryKey: keys.plan })
            void queryClient.invalidateQueries({ queryKey: keys.outputs })
          } else if (name === 'outputs') {
            void queryClient.invalidateQueries({ queryKey: keys.outputs })
            void queryClient.invalidateQueries({ queryKey: keys.status })
          } else if (name === 'prices') {
            void queryClient.invalidateQueries({ queryKey: ['prices'] })
            void queryClient.invalidateQueries({ queryKey: keys.inputs })
          } else if (name === 'emhass') {
            void queryClient.invalidateQueries({ queryKey: keys.emhass })
            void queryClient.invalidateQueries({ queryKey: keys.status })
          } else if (name === 'problems') {
            void queryClient.invalidateQueries({ queryKey: keys.problems })
            void queryClient.invalidateQueries({ queryKey: keys.status })
          } else if (name === 'status') {
            void queryClient.invalidateQueries({ queryKey: keys.status })
            void queryClient.invalidateQueries({ queryKey: keys.inputs })
          }
        }
        pending.clear()
      }, 250)
    }

    const startPolling = () => {
      setState('polling')
      pollTimer = window.setInterval(() => {
        invalidate('runs')
        invalidate('jobs')
        void queryClient.invalidateQueries({ queryKey: keys.status })
      }, POLL_MS)
    }

    const connect = () => {
      if (closed) return
      source = new EventSource(apiUrl(`/api/events?topics=${TOPICS}`))
      source.onopen = () => {
        failures = 0
        setState('live')
      }
      source.onerror = () => {
        source?.close()
        source = null
        failures += 1
        if (failures >= MAX_FAILURES_BEFORE_POLLING) {
          startPolling()
          // keep trying occasionally; a working stream ends polling
          retryTimer = window.setTimeout(() => {
            window.clearInterval(pollTimer)
            failures = MAX_FAILURES_BEFORE_POLLING - 1
            connect()
          }, 60_000)
          return
        }
        setState('reconnecting')
        retryTimer = window.setTimeout(connect, Math.min(1000 * 2 ** failures, 15_000))
      }
      source.addEventListener('log', (event) => {
        const entry = JSON.parse((event as MessageEvent<string>).data) as LogEntry
        for (const listener of listeners.current) listener(entry)
      })
      source.addEventListener('run.started', () => invalidate('runs'))
      source.addEventListener('run.finished', (event) => {
        invalidate('runs')
        let job = ''
        try {
          job = String((JSON.parse((event as MessageEvent<string>).data) as { job?: string }).job ?? '')
        } catch {
          /* ignore malformed event data */
        }
        for (const family of familiesForJob(job)) invalidate(family)
      })
      source.addEventListener('plan.updated', () => invalidate('plan'))
      source.addEventListener('plan.published', () => invalidate('plan'))
      for (const topic of ['problem.opened', 'problem.updated', 'problem.resolved']) {
        source.addEventListener(topic, () => invalidate('problems'))
      }
      for (const topic of ['ha.connected', 'ha.disconnected']) {
        source.addEventListener(topic, () => invalidate('status'))
      }
      source.addEventListener('job.updated', () => invalidate('jobs'))
      source.addEventListener('settings.changed', () => invalidate('settings'))
    }

    connect()
    return () => {
      closed = true
      source?.close()
      window.clearTimeout(retryTimer)
      window.clearInterval(pollTimer)
      window.clearTimeout(invalidateTimer)
    }
  }, [queryClient])

  const subscribeLogs = useCallback((listener: LogListener) => {
    listeners.current.add(listener)
    return () => {
      listeners.current.delete(listener)
    }
  }, [])
  const value = useMemo<EventsContextValue>(() => ({ state, subscribeLogs }), [state, subscribeLogs])
  return <EventsContext.Provider value={value}>{children}</EventsContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useEvents(): EventsContextValue {
  return useContext(EventsContext)
}
