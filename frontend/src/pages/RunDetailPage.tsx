import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { api, apiUrl } from '../api/client'
import { keys, useJobs, useRun, useStatus } from '../api/queries'
import type { ArtifactInfo, LogEntry } from '../api/types'
import { JsonViewer } from '../components/JsonViewer'
import { OutcomeChip } from '../components/Outcome'
import { Empty, ErrorNotice, PageHead } from '../components/PageHead'
import { copyText, downloadText } from '../lib/download'
import { formatBytes, formatDuration, formatTime } from '../lib/format'
import { RunInsights } from './RunInsights'
import { LabelledLamp } from '../components/Lamp'

export function RunDetailPage() {
  const id = Number(useParams().id)
  const run = useRun(id)
  const jobs = useJobs()
  const status = useStatus()
  const queryClient = useQueryClient()
  const logs = useQuery({
    queryKey: ['run-logs', id, run.data?.outcome],
    queryFn: () => api.get<LogEntry[]>(`/api/runs/${id}/logs`),
    enabled: Number.isFinite(id),
  })
  const pin = useMutation({
    mutationFn: (pinned: boolean) => api.post(`/api/runs/${id}/pin?pinned=${pinned}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.run(id) })
      void queryClient.invalidateQueries({ queryKey: ['runs'] })
    },
  })

  if (!Number.isFinite(id)) return <Empty title="No such run" />
  const r = run.data
  const jobTitle = jobs.data?.find((j) => j.id === r?.job)?.title ?? (r ? (EXTRA_JOB_TITLES[r.job] ?? r.job) : undefined)
  const writable = status.data?.writable ?? false

  return (
    <>
      <p style={{ margin: '0 0 8px' }}>
        <Link to="/runs">All runs</Link>
      </p>
      <PageHead title={r ? `Run ${r.id}: ${jobTitle}` : `Run ${id}`}>
        {r && (
          <div className="toolbar">
            <OutcomeChip outcome={r.outcome} />
            <button type="button" disabled={!writable || pin.isPending} onClick={() => pin.mutate(!r.pinned)}>
              {r.pinned ? 'Unpin' : 'Pin (keep forever)'}
            </button>
            <a className="button" href={apiUrl(`/api/runs/${id}/bundle`)} download>
              Download bundle
            </a>
          </div>
        )}
      </PageHead>
      <ErrorNotice error={run.error ?? pin.error} />
      {r && (
        <>
          <section className="panel">
            <div className="panel-body">
              <dl className="facts">
                <div>
                  <dt>Started</dt>
                  <dd>
                    <time dateTime={r.started_at}>{formatTime(r.started_at)}</time>
                  </dd>
                </div>
                <div>
                  <dt>Took</dt>
                  <dd>{r.outcome === 'running' ? 'Running…' : formatDuration(r.duration_ms)}</dd>
                </div>
                <div>
                  <dt>Started by</dt>
                  <dd>{r.trigger}</dd>
                </div>
                {r.scheduled_at && (
                  <div>
                    <dt>Scheduled for</dt>
                    <dd>
                      <time dateTime={r.scheduled_at}>{formatTime(r.scheduled_at)}</time>
                    </dd>
                  </div>
                )}
                {r.mode && (
                  <div>
                    <dt>EMHASS mode</dt>
                    <dd>{r.mode.replace('_', ' ')}</dd>
                  </div>
                )}
                <div>
                  <dt>Settings revision</dt>
                  <dd>{r.settings_rev ?? '—'}</dd>
                </div>
              </dl>
              {r.summary &&
                (r.job.startsWith('driver.') ? (
                  <p className="run-headline" style={{ margin: '16px 0 0' }}>
                    <LabelledLamp color={r.outcome === 'ok' ? 'green' : r.outcome === 'running' ? 'neutral' : 'red'} text={r.summary} />
                  </p>
                ) : (
                  <p style={{ margin: '16px 0 0' }}>{r.summary}</p>
                ))}
              {r.error && <div className="error-box">{r.error}</div>}
            </div>
          </section>

          <RunInsights runId={id} job={r.job} kinds={r.artifacts.map((a) => a.kind)} />

          <section className="panel">
            <div className="panel-head">
              <h2>Details</h2>
              <span className="muted">What the run looked at and produced</span>
            </div>
            {r.artifacts.length === 0 ? (
              <Empty title="Nothing stored for this run">This job doesn't record inputs or payloads.</Empty>
            ) : (
              r.artifacts.map((a) => <Artifact key={a.id} runId={id} artifact={a} />)
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Logs</h2>
              <Link to={`/logs?run=${id}`}>Open in Logs</Link>
            </div>
            <div className="log-list" style={{ maxHeight: 420, minHeight: 0, border: 0 }}>
              {(logs.data ?? []).map((l) => (
                <div key={l.id} className="log-line" data-level={l.level}>
                  <time className="log-ts" dateTime={l.ts}>
                    {new Date(l.ts).toLocaleTimeString(undefined, { hour12: false })}
                  </time>
                  <span className="log-level" data-level={l.level}>
                    {l.level === 'WARNING' ? 'WARN' : l.level}
                  </span>
                  <span className="log-comp">{l.component}</span>
                  <span className="log-msg">{l.msg}</span>
                  {l.exc && (
                    <details className="log-exc">
                      <summary>Traceback</summary>
                      {l.exc}
                    </details>
                  )}
                </div>
              ))}
              {logs.isSuccess && logs.data.length === 0 && <div className="empty">This run wrote no log lines.</div>}
            </div>
          </section>
        </>
      )}
    </>
  )
}

/** Runs that aren't scheduler jobs (so they aren't in /api/jobs). */
const EXTRA_JOB_TITLES: Record<string, string> = {
  'inverter.decide': 'Inverter decision',
  'inverter.compare': 'Inverter comparison',
  'charger.decide': 'EV charger decision',
  'charger.compare': 'EV charger comparison',
  'external.resume': 'Resume after a market session',
  'driver.take_over': 'Take over from the HACS integration',
  'driver.hand_back': 'Hand back to the HACS integration',
}

const ARTIFACT_NAMES: Record<string, string> = {
  event: 'Event sent to Home Assistant',
  inputs: 'Inputs',
  request: 'Request sent',
  explain: 'Explain',
  validation: 'Validation',
  response: 'Response',
  emhass_last_run: 'EMHASS last run',
  plan: 'Plan',
  checks: 'Configuration checks',
  emhass_config: 'EMHASS configuration',
  parity: 'Parity report',
  forecast: 'Forecast',
  next: 'Next fetches',
  last_run: 'EMHASS last run',
  decision: 'Inverter decision',
  calls: 'Service calls',
  readback: 'Read back',
  comparison: 'Compared with the automation',
  charger_decision: 'Charger decision',
  charger_calls: 'Service calls',
  charger_readback: 'Read back',
  charger_comparison: 'Compared with the automation',
  resume: 'Resume steps',
}

function Artifact({ runId, artifact }: { runId: number; artifact: ArtifactInfo }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const data = useQuery({
    queryKey: ['artifact', runId, artifact.kind],
    queryFn: () => api.get<unknown>(`/api/runs/${runId}/artifacts/${encodeURIComponent(artifact.kind)}`),
    enabled: open,
    staleTime: Infinity,
  })
  const text = () => JSON.stringify(data.data, null, 2)
  return (
    <div className="artifact">
      <div className="artifact-head">
        <button type="button" className="expander" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? '▾' : '▸'} {ARTIFACT_NAMES[artifact.kind] ?? artifact.kind}
        </button>
        <span className="muted">{formatBytes(artifact.size)}</span>
        {open && data.isSuccess && (
          <>
            <button
              type="button"
              className="quiet"
              onClick={async () => {
                setCopied(await copyText(text()))
                window.setTimeout(() => setCopied(false), 1500)
              }}
            >
              {copied ? 'Copied' : 'Copy JSON'}
            </button>
            <button
              type="button"
              className="quiet"
              onClick={() => downloadText(`run-${runId}-${artifact.kind}.json`, text(), 'application/json')}
            >
              Download
            </button>
          </>
        )}
      </div>
      {open && (
        <div className="artifact-body">
          {data.isLoading && <span className="muted">Loading…</span>}
          <ErrorNotice error={data.error} />
          {data.isSuccess && <JsonViewer value={data.data} />}
        </div>
      )}
    </div>
  )
}
