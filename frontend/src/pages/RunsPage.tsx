import { useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { api, apiUrl, query } from '../api/client'
import { useJobs, useRuns, useStatus } from '../api/queries'
import type { RunSummary } from '../api/types'
import { MultiFilter, type MultiOption } from '../components/MultiFilter'
import { OutcomeChip } from '../components/Outcome'
import { RunTimeline } from '../components/RunTimeline'
import { useMediaQuery } from '../components/useMediaQuery'
import { RunPreview } from './RunPreview'
import { multiQuery, readMulti, writeMulti, type MultiValue } from '../lib/multiFilter'
import { OUTCOME_NAMES, OUTCOMES, outcomeLabel } from '../lib/outcomes'
import { Empty, ErrorNotice, PageHead } from '../components/PageHead'
import { SortableTh } from '../components/SortableTh'
import { localInputToIso, shiftDay, todayKey } from '../lib/days'
import { formatDateTime, formatDuration } from '../lib/format'
import { nextSort, sortRows, type SortDir } from '../lib/sort'
import { isTimelineWindow, type TimelineWindow } from '../lib/runLanes'
import { MAX_DOWNLOAD, span, tickState, toggled } from '../lib/runPick'

const PAGE = 100
/** Columns the server orders by (run id, which follows the start time); the rest sort the loaded rows. */
const SERVER_SORTED = new Set(['id', 'started'])

export function RunsPage() {
  const [params, setParams] = useSearchParams()
  const job = readMulti(params, 'job')
  const outcome = readMulti(params, 'outcome')
  const wrote = params.get('wrote') === 'inverter'
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const sortKey = params.get('sort') ?? 'started'
  const sortDir: SortDir = params.get('dir') === 'asc' ? 'asc' : 'desc'
  const sort = { key: sortKey, dir: sortDir }
  // Wide screens show a picked run beside the list; narrow ones open it
  const wide = useMediaQuery('(min-width: 1180px)')
  const picked = Number(params.get('run')) || null
  const previewed = wide ? picked : null
  const timelineWindow: TimelineWindow = isTimelineWindow(params.get('window'))
    ? (params.get('window') as TimelineWindow)
    : '6h'
  const order: SortDir = SERVER_SORTED.has(sortKey) ? sortDir : 'desc'

  const tz = useStatus().data?.timezone
  const since = localInputToIso(from, tz) || undefined
  const until = localInputToIso(to, tz) || undefined
  const filters = {
    ...multiQuery('job', job),
    ...multiQuery('outcome', outcome),
    since,
    until,
    order: order === 'asc' ? ('asc' as const) : undefined,
    wrote: wrote ? ('inverter' as const) : undefined,
  }
  const runs = useRuns({ ...filters, limit: PAGE })
  const jobs = useJobs()
  const navigate = useNavigate()
  const [more, setMore] = useState<RunSummary[]>([])
  const [moreKey, setMoreKey] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [noMore, setNoMore] = useState(false)
  // Ticked runs by id, so they stay ticked through refetches, filter changes and loading more
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set())
  const anchor = useRef<number | null>(null)
  const filterKey = JSON.stringify([job, outcome, since, until, order, wrote])
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
  const setMulti = (key: string, value: MultiValue) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        writeMulti(next, key, value)
        return next
      },
      { replace: true },
    )
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
  // A–Z by title; a picked job that is no longer registered stays in the list so it can be unticked
  const jobOptions: MultiOption[] = [
    ...(jobs.data ?? []).map((j) => j.id),
    ...job.values.filter((id) => !jobs.data?.some((j) => j.id === id)),
  ]
    .map((id) => ({ value: id, label: jobTitle(id) }))
    .sort((a, b) => a.label.localeCompare(b.label))
  const outcomeOptions: MultiOption[] = [
    ...OUTCOME_NAMES,
    ...outcome.values.filter((o) => !OUTCOME_NAMES.includes(o)),
  ].map((o) => ({ value: o, label: outcomeLabel(o), lamp: OUTCOMES[o]?.color ?? 'neutral' }))
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

  const shownIds = shown.map((run) => run.id)
  const shownTicks = tickState(shownIds, ticked)
  const tick = (id: number, on: boolean, range: boolean) => {
    // Read the anchor now: React may run the updater after it has moved to this row
    const ids = range ? span(shownIds, anchor.current, id) : [id]
    anchor.current = id
    setTicked((prev) => toggled(prev, ids, on))
  }
  const tickAll = (on: boolean) => {
    setTicked((prev) => toggled(prev, shownIds, on))
    anchor.current = null
  }
  const clearTicks = () => {
    setTicked(new Set())
    anchor.current = null
  }
  const hiddenTicks = ticked.size - shownIds.filter((id) => ticked.has(id)).length
  const tickedQuery = query({ id: [...ticked].sort((a, b) => a - b).map(String) })

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
  const filtered = ranged || wrote || job.values.length > 0 || outcome.values.length > 0
  const pick = (id: number) => (wide ? setFilters({ run: String(id) }) : navigate(`/runs/${id}`))
  return (
    <>
      <PageHead
        title="Runs"
        intro="Every job execution, including the ones that were skipped, refused or missed. Open a run to see its inputs, what it sent, what came back and its logs."
      />
      <RunTimeline
        window={timelineWindow}
        onWindow={(w) => setFilters({ window: w === '6h' ? '' : w })}
        timeZone={tz}
        onPick={pick}
      />
      <div className="toolbar list-controls" style={{ marginBottom: 12 }}>
        <MultiFilter
          label="Job"
          noun="jobs"
          options={jobOptions}
          value={job}
          onChange={(v) => setMulti('job', v)}
        />
        <MultiFilter
          label="Outcome"
          noun="outcomes"
          options={outcomeOptions}
          value={outcome}
          onChange={(v) => setMulti('outcome', v)}
        />
        <label className="check" title="The runs that wrote to the inverter: the plan's and the market sessions'">
          <input
            type="checkbox"
            checked={wrote}
            onChange={(e) => setFilters({ wrote: e.target.checked ? 'inverter' : '' })}
          />
          Wrote to the inverter
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
          <div className="table-wrap">
            <table className="runs-table">
              <thead>
                <tr>
                  <th className="tick">
                    <label>
                      <input
                        type="checkbox"
                        aria-label="Select all shown runs"
                        checked={shownTicks === 'all'}
                        ref={(el) => {
                          if (el) el.indeterminate = shownTicks === 'some'
                        }}
                        disabled={shownIds.length === 0}
                        onChange={(e) => tickAll(e.target.checked)}
                      />
                    </label>
                  </th>
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
                    <td className="tick" onClick={(e) => e.stopPropagation()}>
                      <label>
                        <input
                          type="checkbox"
                          aria-label={`Select run ${run.id}`}
                          checked={ticked.has(run.id)}
                          // A checkbox's change comes from its click, which says whether shift was held
                          onChange={(e) => tick(run.id, e.target.checked, (e.nativeEvent as MouseEvent).shiftKey)}
                        />
                      </label>
                    </td>
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
          {ticked.size > 0 && (
            <div className="run-pick-bar" role="region" aria-label="Selected runs">
              <span>
                {ticked.size === 1 ? '1 run selected' : `${ticked.size} runs selected`}
                {hiddenTicks > 0 && <span className="muted">, {hiddenTicks} of them not shown</span>}
              </span>
              {ticked.size > MAX_DOWNLOAD ? (
                <span className="muted">Untick some: at most {MAX_DOWNLOAD} runs per download</span>
              ) : (
                <>
                  <a className="button" href={apiUrl(`/api/runs/logs${tickedQuery}`)} download>
                    Download logs (.log)
                  </a>
                  <a className="button" href={apiUrl(`/api/runs/bundles${tickedQuery}`)} download>
                    Download bundles (.zip)
                  </a>
                </>
              )}
              <button type="button" className="quiet" onClick={clearTicks}>
                Clear
              </button>
            </div>
          )}
          {runs.isSuccess && loaded.length === 0 && (
            <Empty title={filtered ? 'No runs match the filters' : 'No runs yet'}>
              {filtered ? (
                'Widen the time range or change the job or outcome filter.'
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
