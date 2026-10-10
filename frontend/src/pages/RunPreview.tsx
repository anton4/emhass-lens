import { Link } from 'react-router'
import { useRun } from '../api/queries'
import { Icon } from '../components/Icon'
import { OutcomeChip } from '../components/Outcome'
import { ErrorNotice } from '../components/PageHead'
import { formatDateTime, formatDuration } from '../lib/format'
import { ARTIFACT_NAMES } from '../lib/artifacts'

/** A run beside the Runs list: what it was, how it ended and what it stored; the full page is one click away. */
export function RunPreview({
  id,
  jobTitle,
  timeZone,
  onClose,
}: {
  id: number
  jobTitle: (job: string) => string
  timeZone?: string
  onClose: () => void
}) {
  const run = useRun(id)
  const r = run.data
  return (
    <aside className="run-preview" aria-label={`Run ${id}`}>
      <div className="run-preview-head">
        <h2>Run {id}</h2>
        {r && <OutcomeChip outcome={r.outcome} />}
        <button type="button" className="quiet icon-button" aria-label="Close the preview" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <ErrorNotice error={run.error} />
      {r && (
        <>
          <div className="run-preview-job">{jobTitle(r.job)}</div>
          <dl className="facts facts-tight">
            <div>
              <dt>Started</dt>
              <dd>
                <time dateTime={r.started_at}>{formatDateTime(r.started_at, timeZone)}</time>
              </dd>
            </div>
            <div>
              <dt>Took</dt>
              <dd>{r.outcome === 'running' ? 'Running…' : formatDuration(r.duration_ms)}</dd>
            </div>
            <div>
              <dt>Started by</dt>
              <dd>
                {r.trigger}
                {r.mode ? `, ${r.mode.replace('_', ' ')}` : ''}
              </dd>
            </div>
            <div>
              <dt>Settings revision</dt>
              <dd>{r.settings_rev ?? '—'}</dd>
            </div>
          </dl>
          {r.summary && <p className="run-preview-summary">{r.summary}</p>}
          {r.error && <div className="error-box">{r.error}</div>}
          {r.artifacts.length > 0 && (
            <>
              <h3 className="run-preview-sub">Stored ({r.artifacts.length})</h3>
              <ul className="run-preview-artifacts">
                {r.artifacts.map((a) => (
                  <li key={a.id}>{ARTIFACT_NAMES[a.kind] ?? a.kind}</li>
                ))}
              </ul>
            </>
          )}
          <div className="toolbar">
            <Link className="button primary" to={`/runs/${id}`}>
              Open run
            </Link>
            <Link className="button" to={`/runs/${id}?tab=logs`}>
              Logs
            </Link>
          </div>
        </>
      )}
    </aside>
  )
}
