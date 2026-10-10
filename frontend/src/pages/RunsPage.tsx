import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { api, query } from '../api/client'
import { useJobs, useRuns, useStatus } from '../api/queries'
import type { RunSummary } from '../api/types'
import { OutcomeChip } from '../components/Outcome'
import { RunTimeline } from '../components/RunTimeline'
import { useMediaQuery } from '../components/useMediaQuery'
import { useNow } from '../components/useNow'
import { RunPreview } from './RunPreview'
import { OUTCOME_NAMES, outcomeLabel } from '../lib/outcomes'
import { Empty, ErrorNotice, PageHead } from '../components/PageHead'
import { SortableTh } from '../components/SortableTh'
import { localInputToIso, shiftDay, todayKey } from '../lib/days'
import { formatDateTime, formatDuration } from '../lib/format'
import { nextSort, sortRows, type SortDir } from '../lib/sort'

const PAGE = 100
/** Columns the server orders by (run id, which follows the start time); the rest sort the loaded rows. */
const SERVER_SORTED = new Set(['id', 'started'])

export function RunsPage() {
  const [params, setParams] = useSearchParams()
  const job = params.get('job') ?? ''
  const outcome = params.get('outcome') ?? ''
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const sortKey = params.get('sort') ?? 'started'
  const sortDir: SortDir = params.get('dir') === 'asc' ? 'asc' : 'desc'
  const sort = { key: sortKey, dir: sortDir }
  // Wide screens show a picked run beside the list; narrow ones open it
  const wide = useMediaQuery('(min-width: 1180px)')
  const picked = Number(params.get('run')) || null
  const previewed = wide ? picked : null
  const now = useNow(60_000)
  const order: SortDir = SERVER_SORTED.has(sortKey) ? sortDir : 'desc'

  const tz = useStatus().data?.timezone
  const since = localInputToIso(from, tz) || undefined
  const until = localInputToIso(to, tz) || undefined
  const filters = {
    job: job || undefined,
    outcome: outcome || undefined,
    since,
    until,
    order: order === 'asc' ? ('asc' as const) : undefined,
  }
  const runs = useRuns({ ...filters, limit: PAGE })
  const jobs = useJobs()
  const navigate = useNavigate()
  const [more, setMore] = useState<RunSummary[]>([])
  const [moreKey, setMoreKey] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [noMore, setNoMore] = useState(false)
  const filterKey = `${job}|${outcome}|${since}|${until}|${order}`
  if (moreKey !== filterKey) {
    setMoreKey(filterKey)
    setMore([])
    setNoMore(false)
  }

  const setFilters = (patch: Record<string, string>) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [key, value] of Object.entries(patch)) {
          if (value) next.set(key, value)
          else next.delete(key)
        }
        return next
      },
      { replace: true },
    )
  }
  const onSort = (key: string) => {
    const next = nextSort(sort, key, key === 'job' || key === 'outcome' ? 'asc' : 'desc')
    const isDefault = next.key === 'started' && next.dir === 'desc'
    setFilters({ sort: isDefault ? '' : next.key, dir: isDefault ? '' : next.dir })
  }
  const today = todayKey(tz)
  const setDay = (day: string) => setFilters({ from: `${day}T00:00`, to: `${shiftDay(day, 1)}T00:00` })

  const first = runs.data ?? []
  const loaded = [...first, ...more.filter((o) => !first.some((r) => r.id === o.id))]
  const jobTitle = (id: string) => jobs.data?.find((j) => j.id === id)?.title ?? id
  const shown = SERVER_SORTED.has(sortKey)
    ? loaded
    : sortRows(
        loaded,
        (run) =>
          sortKey === 'job'
            ? jobTitle(run.job)
            : sortKey === 'took'
              ? run.outcome === 'running'
                ? null
                : run.duration_ms
              : outcomeLabel(run.outcome),
        sortDir,
      )

  const loadMore = async () => {
    const last = loaded[loaded.length - 1]?.id
    if (!last) return
    setLoadingMore(true)
    try {
      const page = await api.get<RunSummary[]>(
        `/api/runs${query({ ...filters, limit: PAGE, ...(order === 'asc' ? { after: last } : { before: last }) })}`,
      )
      if (page.length < PAGE) setNoMore(true)
      setMore((prev) => [...prev, ...page])
    } finally {
      setLoadingMore(false)
    }
  }

  const ranged = Boolean(from || to)
  const pick = (id: number) => (wide ? setFilters({ run: String(id) }) : navigate(`/runs/${id}`))
  const nowS = now.getTime() / 1000
  const oldest = loaded.reduce((min, r) => Math.min(min, Date.parse(r.started_at) / 1000), nowS)
  const windowFrom = since ? Date.parse(since) / 1000 : oldest
  const windowTo = Math.min(until ? Date.parse(until) / 1000 : nowS, nowS)
  return (
    <>
      <PageHead
        title="Runs"
        intro="Every job execution, including the ones that were skipped, refused or missed. Open a run to see its inputs, what it sent, what came back and its logs."
      />
      <div className="toolbar list-controls" style={{ marginBottom: 12 }}>
        <label>
          <span className="visually-hidden">Job</span>
          <select value={job} onChange={(e) => setFilters({ job: e.target.value })}>
            <option value="">All jobs</option>
            {(jobs.data ?? []).map((j) => (
              <option key={j.id} value={j.id}>
                {j.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="visually-hidden">Outcome</span>
          <select value={outcome} onChange={(e) => setFilters({ outcome: e.target.value })}>
            <option value="">All outcomes</option>
            {OUTCOME_NAMES.map((o) => (
              <option key={o} value={o}>
                {outcomeLabel(o)}
              </option>
            ))}
          </select>
        </label>
        <label className="range-input">
          <span className="muted">From</span>
          <input
            type="datetime-local"
            value={from}
            max={to || undefined}
            onChange={(e) => setFilters({ from: e.target.value })}
          />
        </label>
        <label className="range-input">
          <span className="muted">To</span>
          <input
            type="datetime-local"
            value={to}
            min={from || undefined}
            onChange={(e) => setFilters({ to: e.target.value })}
          />
        </label>
        <div className="day-picker" role="group" aria-label="Quick ranges">
          <button
            type="button"
            className="quiet"
            aria-pressed={from === `${today}T00:00` && to === `${shiftDay(today, 1)}T00:00`}
            onClick={() => setDay(today)}
          >
            Today
          </button>
          <button
            type="button"
            className="quiet"
            aria-pressed={from === `${shiftDay(today, -1)}T00:00` && to === `${today}T00:00`}
            onClick={() => setDay(shiftDay(today, -1))}
          >
            Yesterday
          </button>
          <button type="button" className="quiet" disabled={!ranged} onClick={() => setFilters({ from: '', to: '' })}>
            Any time
          </button>
        </div>
      </div>
      <ErrorNotice error={runs.error} />
      <div className="runs-split" data-preview={previewed !== null || undefined}>
        <section className="panel">
          <RunTimeline
            runs={loaded}
            from={windowFrom}
            to={windowTo}
            timeZone={tz}
            jobTitle={jobTitle}
            selected={previewed}
            onPick={(run) => pick(run.id)}
          />
          <div className="table-wrap">
            <table className="runs-table">
              <thead>
                <tr>
                  <SortableTh label="Run" sortKey="id" sort={sort} onSort={onSort} />
                  <SortableTh label="Job" sortKey="job" sort={sort} onSort={onSort} />
                  <SortableTh label="Started" sortKey="started" sort={sort} onSort={onSort} />
                  <SortableTh label="Took" sortKey="took" sort={sort} onSort={onSort} />
                  <SortableTh label="Outcome" sortKey="outcome" sort={sort} onSort={onSort} />
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((run) => (
                  <tr
                    key={run.id}
                    className="clickable"
                    aria-selected={run.id === previewed || undefined}
                    onClick={() => pick(run.id)}
                  >
                    <td className="num">
                      <Link to={`/runs/${run.id}`} onClick={(e) => e.stopPropagation()}>
                        {run.id}
                      </Link>
                      {run.pinned ? <span className="faint"> pinned</span> : null}
                    </td>
                    <td>
                      <div className="cell-title">{jobTitle(run.job)}</div>
                      <div className="cell-sub">
                        {run.trigger}
                        {run.mode ? `, ${run.mode.replace('_', ' ')}` : ''}
                      </div>
                    </td>
                    <td className="num">
                      <time dateTime={run.started_at}>{formatDateTime(run.started_at, tz)}</time>
                    </td>
                    <td className="num">{run.outcome === 'running' ? '…' : formatDuration(run.duration_ms)}</td>
                    <td>
                      <OutcomeChip outcome={run.outcome} />
                    </td>
                    <td className="wrap">{run.error ?? run.summary ?? <span className="faint">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {runs.isSuccess && loaded.length === 0 && (
            <Empty title={ranged || job || outcome ? 'No runs match the filters' : 'No runs yet'}>
              {ranged || job || outcome ? (
                'Widen the time range or pick another job or outcome.'
              ) : (
                <>
                  Jobs run on their schedule; you can also start one from <Link to="/health">Health</Link>.
                </>
              )}
            </Empty>
          )}
          <div className="panel-body cell-sub">
            {!SERVER_SORTED.has(sortKey) && loaded.length > 0 && (
              <>Sorted within the {loaded.length} runs loaded so far. </>
            )}
            Times in {tz ?? "your browser's timezone"}
            {ranged ? ', and the range includes From but not To.' : '.'}
          </div>
          {loaded.length >= PAGE && (
            <div className="panel-body">
              <button type="button" onClick={loadMore} disabled={loadingMore || noMore}>
                {noMore
                  ? order === 'asc'
                    ? 'No newer runs'
                    : 'No older runs'
                  : loadingMore
                    ? 'Loading…'
                    : order === 'asc'
                      ? 'Load newer runs'
                      : 'Load older runs'}
              </button>
            </div>
          )}
        </section>
        {previewed !== null && (
          <RunPreview id={previewed} jobTitle={jobTitle} timeZone={tz} onClose={() => setFilters({ run: '' })} />
        )}
      </div>
    </>
  )
}
