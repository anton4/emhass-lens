// The steps of a run that calls EMHASS (MPC, the cost-function comparison) on one time axis: building the
// payload, each EMHASS call (with EMHASS's own stages inside the live one) and reading back. Runs since 0.4.6
// record when each call was sent; older runs are placed from when each call ended.

import { formatDuration } from './format'

export type StepStatus = 'ok' | 'error' | 'warn' | 'neutral'

export interface PipelineStep {
  key: string
  label: string
  /** Milliseconds from the run's start. */
  startMs: number
  ms: number
  status: StepStatus
  note?: string
  children?: PipelineStep[]
}

export interface Pipeline {
  totalMs: number
  /** EMHASS's solver time in the live call, when EMHASS reports it. */
  solveMs: number | null
  steps: PipelineStep[]
}

export interface CallArtifact {
  sent_at?: string | null
  duration_ms?: number | null
  error?: string | null
}

export interface CostfunArtifact extends CallArtifact {
  costfun: string
  live?: boolean
  optim_status?: string | null
  problem?: string | null
  generated_at?: string | null
}

export interface LastRunArtifact {
  status?: string | null
  timestamp?: string | null
  action?: string | null
  stage_times?: Record<string, number> | null
  duration_total_seconds?: number | null
  error_message?: string | null
}

export interface PipelineInput {
  run: { started_at: string; finished_at?: string | null; duration_ms?: number | null }
  costfuns: CostfunArtifact[]
  response?: CallArtifact | null
  lastRun?: LastRunArtifact | null
  responseRetry?: CallArtifact | null
  lastRunRetry?: LastRunArtifact | null
  /** The cost function the live call used (the request's `costfun`). */
  liveCostfun?: string | null
  /** For a run still going: now, in ms since the epoch. */
  nowMs?: number
}

const COSTFUN_LABEL: Record<string, string> = { profit: 'profit', cost: 'cost', 'self-consumption': 'self-consumption' }

const STAGES: [string, string][] = [
  ['pv_forecast', 'PV forecast'],
  ['load_forecast', 'Load forecast'],
  ['price_prep', 'Price prep'],
  ['optim_solve', 'Optimisation'],
]

function parse(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

interface Call {
  key: string
  label: string
  ms: number
  /** Where the call started, if the run tells; otherwise it follows the previous step. */
  start: number | null
  status: StepStatus
  note?: string
  lastRun?: LastRunArtifact | null
}

function liveCall(
  key: string,
  label: string,
  response: CallArtifact,
  lastRun: LastRunArtifact | null | undefined,
  t0: number,
): Call {
  const ms = response.duration_ms ?? 0
  const sent = parse(response.sent_at)
  const ended = parse(lastRun?.timestamp)
  let status: StepStatus = 'neutral'
  let note: string | undefined
  if (response.error) {
    status = 'error'
    note = response.error
  } else if (lastRun?.status === 'error') {
    status = 'error'
    note = lastRun.error_message || 'EMHASS reported an error'
  } else if (lastRun?.status === 'ok') {
    status = 'ok'
  } else if (lastRun?.status) {
    status = 'warn'
    note = `EMHASS reported ${lastRun.status}`
  }
  return {
    key,
    label,
    ms,
    start: sent !== null ? sent - t0 : ended !== null ? ended - t0 - ms : null,
    status,
    note,
    lastRun,
  }
}

/** EMHASS's own stages, from its last-run record, laid end to end so they finish with the call. */
function stagesOf(lastRun: LastRunArtifact | null | undefined, callEnd: number, callStart: number): PipelineStep[] {
  const times = lastRun?.stage_times
  if (!times) return []
  // EMHASS's stage times add up to a little more than its own total (they overlap slightly), so lay them end to
  // end from their sum, finishing with the call
  const total = STAGES.reduce((sum, [k]) => sum + (times[k] ?? 0), 0) * 1000
  let at = Math.max(callStart, callEnd - total)
  const out: PipelineStep[] = []
  for (const [key, label] of STAGES) {
    const s = times[key]
    if (s === undefined) continue
    const ms = s * 1000
    const parts = ['build', 'solve', 'extract']
      .map((p) => [p, times[`${key}.${p}`]] as const)
      .filter((p): p is readonly [string, number] => p[1] !== undefined)
    out.push({
      key: `stage:${key}`,
      label,
      startMs: at,
      ms,
      status: 'neutral',
      note: parts.length ? parts.map(([p, v]) => `${p} ${formatDuration(v * 1000)}`).join(' · ') : undefined,
    })
    at += ms
  }
  return out
}

export function buildPipeline(input: PipelineInput): Pipeline {
  const t0 = Date.parse(input.run.started_at)
  const finished = parse(input.run.finished_at)
  const totalMs = Math.max(0, input.run.duration_ms ?? (finished !== null ? finished - t0 : (input.nowMs ?? t0) - t0))
  const calls: Call[] = []
  for (const c of input.costfuns) {
    if (c.live) continue
    const ms = c.duration_ms ?? 0
    const sent = parse(c.sent_at)
    const ended = parse(c.generated_at)
    calls.push({
      key: `costfun:${c.costfun}`,
      label: `Cost function · ${COSTFUN_LABEL[c.costfun] ?? c.costfun}`,
      ms,
      start: sent !== null ? sent - t0 : ended !== null ? ended - t0 - ms : null,
      status: c.problem ? 'warn' : c.optim_status === 'ok' ? 'ok' : 'neutral',
      note: c.problem ?? undefined,
    })
  }
  const action = input.lastRun?.action ?? 'naive-mpc-optim'
  const liveLabel = `EMHASS ${action}${input.liveCostfun ? ` (${input.liveCostfun})` : ''}`
  if (input.response) calls.push(liveCall('live', liveLabel, input.response, input.lastRun, t0))
  if (input.responseRetry) {
    calls.push(liveCall('retry', `${liveLabel}, retry`, input.responseRetry, input.lastRunRetry, t0))
  }

  // In order, never overlapping (end times have one-second precision), inside the run
  const clamp = (v: number) => Math.min(Math.max(v, 0), totalMs)
  const placed: PipelineStep[] = []
  let cursor = 0
  for (const call of calls) {
    const startMs = clamp(Math.max(call.start ?? cursor, cursor))
    const ms = Math.min(call.ms, totalMs - startMs)
    const children = call.lastRun ? stagesOf(call.lastRun, startMs + ms, startMs) : undefined
    placed.push({
      key: call.key,
      label: call.label,
      startMs,
      ms,
      status: call.status,
      note: call.note,
      children: children && children.length ? children : undefined,
    })
    cursor = startMs + ms
  }

  const firstCall = placed[0]
  const steps: PipelineStep[] = [
    {
      key: 'build',
      label: 'Build payload',
      startMs: 0,
      ms: firstCall ? firstCall.startMs : totalMs,
      status: 'ok',
    },
    ...placed,
  ]
  if (placed.length && totalMs - cursor >= 200) {
    steps.push({ key: 'after', label: 'Read back and store', startMs: cursor, ms: totalMs - cursor, status: 'neutral' })
  }
  const solve = input.lastRun?.stage_times?.['optim_solve.solve']
  return { totalMs, solveMs: solve !== undefined ? solve * 1000 : null, steps }
}
