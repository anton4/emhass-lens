import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { api, query } from '../api/client'
import { useJobs, useRuns } from '../api/queries'
import type { RunSummary } from '../api/types'
import { OutcomeChip } from '../components/Outcome'
import { OUTCOME_NAMES, outcomeLabel } from '../lib/outcomes'
import { Empty, ErrorNotice, PageHead } from '../components/PageHead'
import { formatDuration, formatTime } from '../lib/format'

const PAGE = 100

export function RunsPage() {
  const [params, setParams] = useSearchParams()
  const job = params.get('job') ?? ''
  const outcome = params.get('outcome') ?? ''
  const runs = useRuns({ job: job || undefined, outcome: outcome || undefined, limit: PAGE })
  const jobs = useJobs()
  const navigate = useNavigate()
  const [older, setOlder] = useState<RunSummary[]>([])
  const [olderKey, setOlderKey] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [noMore, setNoMore] = useState(false)
  const filterKey = `${job}|${outcome}`
  if (olderKey !== filterKey) {
    setOlderKey(filterKey)
    setOlder([])
    setNoMore(false)
  }

  const setFilter = (key: string, value: string) => {
    if (value) params.set(key, value)
    else params.delete(key)
    setParams(params)
  }

  const all = [...(runs.data ?? []), ...older.filter((o) => !(runs.data ?? []).some((r) => r.id === o.id))]

  const loadMore = async () => {
    const oldest = all[all.length - 1]?.id
    if (!oldest) return
    setLoadingMore(true)
    try {
      const more = await api.get<RunSummary[]>(
        `/api/runs${query({ job: job || undefined, outcome: outcome || undefined, limit: PAGE, before: oldest })}`,
      )
      if (more.length < PAGE) setNoMore(true)
      setOlder((prev) => [...prev, ...more])
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <>
      <PageHead
        title="Runs"
        intro="Every job execution, including the ones that were skipped, refused or missed. Open a run to see its inputs, what it sent, what came back and its logs."
      />
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <label>
          <span className="visually-hidden">Job</span>
          <select value={job} onChange={(e) => setFilter('job', e.target.value)}>
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
          <select value={outcome} onChange={(e) => setFilter('outcome', e.target.value)}>
            <option value="">All outcomes</option>
            {OUTCOME_NAMES.map((o) => (
              <option key={o} value={o}>
                {outcomeLabel(o)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorNotice error={runs.error} />
      <section className="panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Job</th>
                <th>Started</th>
                <th>Took</th>
                <th>Outcome</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {all.map((run) => (
                <tr key={run.id} className="clickable" onClick={() => navigate(`/runs/${run.id}`)}>
                  <td className="num">
                    <Link to={`/runs/${run.id}`} onClick={(e) => e.stopPropagation()}>
                      {run.id}
                    </Link>
                    {run.pinned ? <span className="faint"> pinned</span> : null}
                  </td>
                  <td>
                    <div className="cell-title">{jobs.data?.find((j) => j.id === run.job)?.title ?? run.job}</div>
                    <div className="cell-sub">
                      {run.trigger}
                      {run.mode ? `, ${run.mode.replace('_', ' ')}` : ''}
                    </div>
                  </td>
                  <td className="num">
                    <time dateTime={run.started_at}>{formatTime(run.started_at)}</time>
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
        {runs.isSuccess && all.length === 0 && (
          <Empty title="No runs yet">
            Jobs run on their schedule; you can also start one from <Link to="/health">Health</Link>.
          </Empty>
        )}
        {all.length >= PAGE && (
          <div className="panel-body">
            <button type="button" onClick={loadMore} disabled={loadingMore || noMore}>
              {noMore ? 'No older runs' : loadingMore ? 'Loading…' : 'Load older runs'}
            </button>
          </div>
        )}
      </section>
    </>
  )
}
