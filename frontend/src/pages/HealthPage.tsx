import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '../api/client'
import { keys, useJobs, useStatus } from '../api/queries'
import type { JobInfo } from '../api/types'
import { LabelledLamp } from '../components/Lamp'
import { statusColor } from '../lib/status'
import { OutcomeChip } from '../components/Outcome'
import { Empty, ErrorNotice, PageHead } from '../components/PageHead'
import { useNow } from '../components/useNow'
import { formatCountdown, formatTime } from '../lib/format'

const COMPONENT_NAMES: Record<string, string> = {
  scheduler: 'Scheduler',
  home_assistant: 'Home Assistant',
  emhass: 'EMHASS',
  nordpool: 'Nord Pool',
  mqtt: 'MQTT',
}

export function HealthPage() {
  const status = useStatus()
  const jobs = useJobs()
  const s = status.data

  return (
    <>
      <PageHead
        title="Health"
        intro="Whether every part of EMHASS Lens is working, and when each job runs next."
      />
      <ErrorNotice error={status.error ?? jobs.error} />

      <section className="panel">
        <div className="panel-head">
          <h2>Problems</h2>
          {s && <span className="muted">{s.problems.length === 0 ? 'None active' : `${s.problems.length} active`}</span>}
        </div>
        {s && s.problems.length === 0 ? (
          <Empty title="No problems">
            Failed fetches, unavailable sensors, refused runs and stale plans show up here once those jobs exist.
          </Empty>
        ) : (
          <ul className="diff-list" style={{ padding: '4px 16px' }}>
            {(s?.problems ?? []).map((p, i) => (
              <li key={i}>
                <span className="diff-path">{String(p.key ?? i)}</span>
                <span>{String(p.title ?? p.detail ?? JSON.stringify(p))}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Jobs</h2>
          <span className="muted">Times in your browser's timezone</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>When</th>
                <th>Next run</th>
                <th>Last run</th>
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(jobs.data ?? []).map((job) => (
                <JobRow key={job.id} job={job} writable={s?.writable ?? false} />
              ))}
            </tbody>
          </table>
        </div>
        {jobs.isSuccess && jobs.data.length === 0 && <Empty title="No jobs registered" />}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Components</h2>
        </div>
        <div className="components">
          {s &&
            Object.entries(s.components).map(([name, comp]) => (
              <div key={name} className="component">
                <div className="component-name">
                  <LabelledLamp color={statusColor(comp.status)} text={COMPONENT_NAMES[name] ?? name} />
                </div>
                <div className="cell-sub">{comp.detail ?? statusText(comp.status)}</div>
              </div>
            ))}
          {s && (
            <div className="component">
              <div className="component-name">Installation</div>
              <div className="cell-sub">
                {s.under_supervisor ? 'Home Assistant App' : 'Standalone'}, timezone {s.timezone}, settings revision{' '}
                {s.settings_revision}
              </div>
            </div>
          )}
        </div>
      </section>
    </>
  )
}

function statusText(status: string): string {
  return { ok: 'Working', warning: 'Needs attention', error: 'Not working', unknown: 'Not checked yet', disabled: 'Off' }[
    status
  ] ?? status
}

function JobRow({ job, writable }: { job: JobInfo; writable: boolean }) {
  const now = useNow(1000)
  const queryClient = useQueryClient()
  const action = useMutation({
    mutationFn: (what: 'run' | 'pause' | 'resume') => api.post(`/api/jobs/${encodeURIComponent(job.id)}/${what}`),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.jobs }),
  })

  return (
    <tr>
      <td>
        <div className="cell-title">{job.title}</div>
        <div className="cell-sub" style={{ maxWidth: '52ch' }}>
          {job.description}
        </div>
        {action.error && <div className="field-error">{(action.error as Error).message}</div>}
      </td>
      <td className="cell-sub">{job.trigger}</td>
      <td>
        {job.paused ? (
          <span className="chip" data-color="amber">
            Paused
          </span>
        ) : job.next_run ? (
          <>
            <div className="countdown">{formatCountdown(job.next_run, now)}</div>
            <div className="cell-sub">
              <time dateTime={job.next_run}>{formatTime(job.next_run, now)}</time>
            </div>
          </>
        ) : (
          <span className="faint">Only on demand</span>
        )}
      </td>
      <td>
        {job.running ? (
          <span className="labelled-lamp">
            <span className="spinner" aria-hidden="true" /> Running
          </span>
        ) : job.last_run_id ? (
          <Link to={`/runs/${job.last_run_id}`} style={{ textDecoration: 'none' }}>
            <OutcomeChip outcome={job.last_outcome} />
          </Link>
        ) : (
          <OutcomeChip outcome={job.last_outcome} />
        )}
        {job.last_finished && (
          <div className="cell-sub">
            <time dateTime={job.last_finished}>{formatTime(job.last_finished, now)}</time>
          </div>
        )}
      </td>
      <td>
        <div className="toolbar" style={{ justifyContent: 'flex-end' }}>
          <button type="button" disabled={!writable || job.running || action.isPending} onClick={() => action.mutate('run')}>
            Run now
          </button>
          <button
            type="button"
            disabled={!writable || action.isPending}
            onClick={() => action.mutate(job.paused ? 'resume' : 'pause')}
          >
            {job.paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </td>
    </tr>
  )
}
