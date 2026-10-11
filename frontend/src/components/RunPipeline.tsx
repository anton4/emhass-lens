import { Fragment } from 'react'
import { useQueries } from '@tanstack/react-query'
import { artifactQuery, useArtifact } from '../api/artifacts'
import type { RunDetail } from '../api/types'
import { formatDuration } from '../lib/format'
import {
  buildPipeline,
  type CallArtifact,
  type CostfunArtifact,
  type LastRunArtifact,
  type PipelineStep,
  type StepStatus,
} from '../lib/pipeline'
import { Lamp, type LampColor } from './Lamp'
import { useNow } from './useNow'

const LAMP: Record<StepStatus, LampColor> = { ok: 'green', error: 'red', warn: 'amber', neutral: 'neutral' }

function pct(ms: number, total: number): string {
  return `${total > 0 ? (ms / total) * 100 : 0}%`
}

function Row({ step, total, child = false }: { step: PipelineStep; total: number; child?: boolean }) {
  return (
    <div className="pipeline-row" data-child={child || undefined}>
      <span className="pipeline-label">
        {!child && <Lamp color={LAMP[step.status]} />}
        <span>{step.label}</span>
        {child && step.note && <span className="muted"> · {step.note}</span>}
      </span>
      <span className="pipeline-track">
        <span
          className="pipeline-bar"
          data-status={step.status}
          style={{ left: pct(step.startMs, total), width: `max(3px, ${pct(step.ms, total)})` }}
        />
      </span>
      <span className="pipeline-ms">{formatDuration(step.ms)}</span>
    </div>
  )
}

/** The steps of a run that called EMHASS, on one time axis: building the payload, each EMHASS call with EMHASS's
 *  own stages inside the live one, and reading back. */
export function RunPipeline({ run }: { run: RunDetail }) {
  const now = useNow(1000)
  const kinds = run.artifacts.map((a) => a.kind)
  const has = (k: string) => kinds.includes(k)
  const costfunKinds = kinds.filter((k) => k.startsWith('costfun:'))
  const costfuns = useQueries({ queries: costfunKinds.map((k) => artifactQuery<CostfunArtifact>(run.id, k)) })
  const response = useArtifact<CallArtifact>(run.id, 'response', has('response'))
  const lastRun = useArtifact<LastRunArtifact>(run.id, 'emhass_last_run', has('emhass_last_run'))
  const retry = useArtifact<CallArtifact>(run.id, 'response_retry', has('response_retry'))
  const lastRunRetry = useArtifact<LastRunArtifact>(run.id, 'emhass_last_run_retry', has('emhass_last_run_retry'))
  const request = useArtifact<{ costfun?: string }>(run.id, 'request', has('request'))

  const loading = [response, lastRun, retry, lastRunRetry, ...costfuns].some((q) => q.isLoading)
  if (loading) return null
  const pipeline = buildPipeline({
    run,
    costfuns: costfuns.flatMap((q) => (q.data ? [q.data] : [])),
    response: response.data,
    lastRun: lastRun.data,
    responseRetry: retry.data,
    lastRunRetry: lastRunRetry.data,
    liveCostfun: request.data?.costfun,
    nowMs: run.outcome === 'running' ? now.getTime() : undefined,
  })
  const total = pipeline.totalMs
  const share = pipeline.solveMs !== null && total > 0 ? Math.round((pipeline.solveMs / total) * 100) : null

  return (
    <section className="panel run-pipeline">
      <div className="panel-head">
        <h2>Pipeline</h2>
        <span className="muted">
          {formatDuration(total)} in total{share !== null && ` · solve took ${share} %`}
        </span>
      </div>
      <div className="pipeline-rows">
        {pipeline.steps.map((step) => (
          <Fragment key={step.key}>
            <Row step={step} total={total} />
            {step.note && (
              <div className="pipeline-note" data-status={step.status}>
                {step.note}
              </div>
            )}
            {step.children?.map((child) => (
              <Row key={child.key} step={child} total={total} child />
            ))}
          </Fragment>
        ))}
        <div className="pipeline-row pipeline-axis" aria-hidden="true">
          <span />
          <span className="pipeline-track">
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <span key={f} style={{ left: `${f * 100}%` }}>
                {formatDuration(total * f)}
              </span>
            ))}
          </span>
          <span />
        </div>
      </div>
    </section>
  )
}
