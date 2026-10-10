import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { api } from '../api/client'
import { keys, useJobs, useProblems, useStatus } from '../api/queries'
import type { JobInfo, RunStarted } from '../api/types'
import { LabelledLamp } from '../components/Lamp'
import { statusColor } from '../lib/status'
import { OutcomeChip } from '../components/Outcome'
import { Empty, ErrorNotice, PageHead } from '../components/PageHead'
import { ProblemList } from '../components/Problems'
import { useNow } from '../components/useNow'
import { COMPONENT_NAMES } from '../lib/components'
import { SortableTh } from '../components/SortableTh'
import { formatCountdown, formatDateTime, formatTime } from '../lib/format'
import { nextSort, sortRows, type SortState } from '../lib/sort'
import { DriverCard } from './health/DriverCard'
import { EmhassCard } from './health/EmhassCard'
import { LegacyImportCard } from './health/LegacyImportCard'
import { MlCard } from './health/MlCard'
import { OutputsCard } from './health/OutputsCard'
import { SetupCard } from './health/SetupCard'
import { StorageCard } from './health/StorageCard'
import { ParityCard } from './health/ParityCard'

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

      <SectionLinks problems={s?.problems.length ?? 0} />

      <SetupCard />

      <ProblemsPanel />

      <div className="two-col">
        <DriverCard writable={s?.writable ?? false} />
        <ComponentsPanel />
      </div>

      <EmhassCard writable={s?.writable ?? false} />

      <OutputsCard />

      <MlCard writable={s?.writable ?? false} />

      <StorageCard writable={s?.writable ?? false} />

      <section id="card-jobs" className="panel">
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

      <ParityCard />
      <LegacyImportCard writable={s?.writable ?? false} />
    </>
  )
}

const SECTIONS = [
  ['card-setup', 'Getting started'],
  ['card-problems', 'Problems'],
  ['card-driver', 'Driving EMHASS'],
  ['card-components', 'Components'],
  ['card-emhass', 'EMHASS'],
  ['card-outputs', 'Outputs'],
  ['card-ml', 'ML forecast'],
  ['card-storage', 'Storage'],
  ['card-jobs', 'Jobs'],
  ['card-parity', 'Parity'],
  ['card-import', 'Import'],
] as const

/** Jump links to the page's sections (the address hash belongs to the router, so these scroll instead). */
function SectionLinks({ problems }: { problems: number }) {
  return (
    <nav className="page-anchors" aria-label="On this page">
      {SECTIONS.map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        >
          {label}
          {id === 'card-problems' && problems > 0 && <span className="tab-count">{problems}</span>}
        </button>
      ))}
    </nav>
  )
}

function ProblemsPanel() {
  const problems = useProblems()
  const tz = useStatus().data?.timezone
  const [sort, setSort] = useState<SortState>({ key: 'started', dir: 'desc' })
  const onSort = (key: string) => setSort(nextSort(sort, key, key === 'problem' ? 'asc' : 'desc'))
  const [params] = useSearchParams()
  const focus = params.get('focus') === 'problems'
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    // the header's problem count links here
    if (focus && problems.isSuccess) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [focus, problems.isSuccess])
  const active = problems.data?.active ?? []
  const history = (problems.data?.history ?? []) as {
    id: number
    severity: string
    title: string
    detail: string | null
    started_at: string
    ended_at: string | null
  }[]
  return (
    <section id="card-problems" className="panel" ref={ref}>
      <div className="panel-head">
        <h2>Problems</h2>
        {problems.data && <span className="muted">{active.length === 0 ? 'None active' : `${active.length} active`}</span>}
      </div>
      <ErrorNotice error={problems.error} />
      {problems.isSuccess && active.length === 0 ? (
        <Empty title="No problems">Failed fetches, unreadable sensors, an unreachable EMHASS and missed jobs show up here.</Empty>
      ) : (
        <div className="panel-body">
          <ProblemList problems={active} />
        </div>
      )}
      {history.length > 0 && (
        <details className="history">
          <summary>History ({history.length})</summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortableTh label="Problem" sortKey="problem" sort={sort} onSort={onSort} />
                  <SortableTh label="Started" sortKey="started" sort={sort} onSort={onSort} />
                  <SortableTh label="Ended" sortKey="ended" sort={sort} onSort={onSort} />
                </tr>
              </thead>
              <tbody>
                {sortRows(
                  history,
                  (h) =>
                    sort.key === 'problem'
                      ? h.title
                      : sort.key === 'ended'
                        ? h.ended_at
                          ? Date.parse(h.ended_at)
                          : null
                        : Date.parse(h.started_at),
                  sort.dir,
                ).map((h) => (
                  <tr key={h.id}>
                    <td>
                      <LabelledLamp color={h.severity === 'error' ? 'red' : 'amber'} text={h.title} />
                      {h.detail && <div className="cell-sub">{h.detail}</div>}
                    </td>
                    <td className="num">{formatDateTime(h.started_at, tz)}</td>
                    <td className="num">
                      {h.ended_at ? formatDateTime(h.ended_at, tz) : <span className="chip">open</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  )
}

function ComponentsPanel() {
  const status = useStatus()
  const s = status.data
  return (
    <section id="card-components" className="panel">
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
  const navigate = useNavigate()
  const action = useMutation({
    mutationFn: (what: 'run' | 'pause' | 'resume') =>
      api.post<RunStarted | JobInfo>(`/api/jobs/${encodeURIComponent(job.id)}/${what}`),
    onSuccess: (result, what) => {
      if (what === 'run' && result && 'run_id' in result && result.run_id) navigate(`/runs/${result.run_id}`)
    },
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
