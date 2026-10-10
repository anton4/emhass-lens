import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api, query } from '../api/client'
import { useEvents } from '../api/events'
import type { LogEntry } from '../api/types'
import { ErrorNotice, PageHead } from '../components/PageHead'
import { downloadText } from '../lib/download'

const MAX_LINES = 2000
const POLL_MS = 5000
const LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR'] as const
const LEVEL_RANK: Record<string, number> = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50 }

const tsFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

function merge(existing: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  const byId = new Map<number, LogEntry>()
  for (const e of existing) byId.set(e.id, e)
  for (const e of incoming) byId.set(e.id, e)
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

function toText(lines: LogEntry[]): string {
  return lines
    .map((l) => {
      const run = l.run_id ? ` run=${l.run_id}` : ''
      const exc = l.exc ? `\n${l.exc}` : ''
      return `${l.ts} ${l.level.padEnd(7)} [${l.component}]${run} ${l.msg}${exc}`
    })
    .join('\n')
}

export function LogsPage() {
  const [params, setParams] = useSearchParams()
  const runFilter = params.get('run') ? Number(params.get('run')) : null
  const [lines, setLines] = useState<LogEntry[]>([])
  const [paused, setPaused] = useState(false)
  const [level, setLevel] = useState<string>('INFO')
  const [component, setComponent] = useState('')
  const [search, setSearch] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [noOlder, setNoOlder] = useState(false)
  const buffer = useRef<LogEntry[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const { subscribeLogs, state } = useEvents()
  const [seenRunFilter, setSeenRunFilter] = useState(runFilter)
  if (seenRunFilter !== runFilter) {
    setSeenRunFilter(runFilter)
    setNoOlder(false)
  }

  // History first; the live stream fills in from there.
  useEffect(() => {
    let cancelled = false
    api
      .get<LogEntry[]>(`/api/logs${query({ limit: 1000, run_id: runFilter })}`)
      .then((history) => {
        if (!cancelled) setLines((prev) => merge(prev, history).slice(-MAX_LINES))
      })
      .catch((err) => !cancelled && setError(err))
    return () => {
      cancelled = true
    }
  }, [runFilter])

  useEffect(() => {
    return subscribeLogs((entry) => {
      buffer.current.push(entry)
    })
  }, [subscribeLogs])

  // Without the live stream (it is reconnecting, or a proxy buffers it) ask for the newest lines every few seconds.
  // They join the same buffer as live lines, so pausing works the same way.
  const streaming = state === 'live' || state === 'connecting'
  useEffect(() => {
    if (streaming) return
    let cancelled = false
    const poll = () => {
      api
        .get<LogEntry[]>(`/api/logs${query({ limit: 500, run_id: runFilter })}`)
        .then((latest) => {
          if (!cancelled) buffer.current = merge(buffer.current, latest)
        })
        .catch(() => {
          /* the next poll tries again; the header shows the connection state */
        })
    }
    poll()
    const id = window.setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [streaming, runFilter])

  // Flush live lines a few times a second (cheap re-render), unless paused.
  useEffect(() => {
    if (paused) return
    const id = window.setInterval(() => {
      if (buffer.current.length === 0) return
      const incoming = buffer.current
      buffer.current = []
      setLines((prev) => merge(prev, incoming).slice(-MAX_LINES))
    }, 300)
    return () => window.clearInterval(id)
  }, [paused])

  const components = useMemo(() => [...new Set(lines.map((l) => l.component))].sort(), [lines])

  const visible = useMemo(() => {
    const min = LEVEL_RANK[level] ?? 0
    const needle = search.trim().toLowerCase()
    return lines.filter(
      (l) =>
        (LEVEL_RANK[l.level] ?? 0) >= min &&
        (!component || l.component === component || l.component.startsWith(`${component}.`)) &&
        (runFilter === null || l.run_id === runFilter) &&
        (!needle || l.msg.toLowerCase().includes(needle) || (l.exc ?? '').toLowerCase().includes(needle)),
    )
  }, [lines, level, component, search, runFilter])

  useEffect(() => {
    const el = listRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [visible])

  const onScroll = useCallback(() => {
    const el = listRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }, [])

  const loadOlder = async () => {
    const oldest = lines[0]?.id
    if (!oldest) return
    setLoadingOlder(true)
    try {
      const older = await api.get<LogEntry[]>(`/api/logs${query({ limit: 500, before_id: oldest, run_id: runFilter })}`)
      if (older.length === 0) setNoOlder(true)
      stickToBottom.current = false
      setLines((prev) => merge(older, prev))
    } catch (err) {
      setError(err)
    } finally {
      setLoadingOlder(false)
    }
  }

  const clearRun = () => {
    params.delete('run')
    setParams(params)
  }

  return (
    <>
      <PageHead
        title="Logs"
        intro="Everything EMHASS Lens does, as it happens. The same lines appear in the App's Log tab in Home Assistant."
      >
        <div className="toolbar">
          <button type="button" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            onClick={() => downloadText(`emhass-lens-${new Date().toISOString().slice(0, 19)}.log`, toText(visible))}
          >
            Download
          </button>
        </div>
      </PageHead>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <label>
          <span className="visually-hidden">Minimum level</span>
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            {LEVELS.map((lv) => (
              <option key={lv} value={lv}>
                {lv === 'DEBUG' ? 'All levels' : `${lv.charAt(0)}${lv.slice(1).toLowerCase()} and above`}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="visually-hidden">Component</span>
          <select value={component} onChange={(e) => setComponent(e.target.value)}>
            <option value="">All components</option>
            {components.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="visually-hidden">Search</span>
          <input
            className="search"
            type="search"
            placeholder="Search messages"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        {runFilter !== null && (
          <span className="chip" data-color="blue">
            Run {runFilter}
            <button type="button" className="quiet" onClick={clearRun} aria-label="Show all runs">
              ✕
            </button>
          </span>
        )}
        <span className="muted" aria-live="polite" style={{ marginLeft: 'auto' }}>
          {visible.length} of {lines.length} lines
          {paused
            ? ', paused'
            : state === 'live'
              ? ', live'
              : streaming
                ? ''
                : `, refreshed every ${POLL_MS / 1000} s`}
        </span>
      </div>
      <ErrorNotice error={error} />
      <div className="log-list" ref={listRef} onScroll={onScroll} role="log" aria-label="Log lines">
        <div style={{ padding: '2px 14px 8px' }}>
          <button type="button" className="quiet" onClick={loadOlder} disabled={loadingOlder || noOlder}>
            {noOlder ? 'No older lines' : loadingOlder ? 'Loading…' : 'Load older lines'}
          </button>
        </div>
        {visible.map((l) => (
          <LogLine key={l.id} line={l} />
        ))}
        {visible.length === 0 && <div className="empty">No lines match these filters.</div>}
      </div>
    </>
  )
}

function LogLine({ line }: { line: LogEntry }) {
  const d = new Date(line.ts)
  return (
    <div className="log-line" data-level={line.level}>
      <time className="log-ts" dateTime={line.ts} title={d.toLocaleString()}>
        {tsFmt.format(d)}
      </time>
      <span className="log-level" data-level={line.level}>
        {line.level === 'WARNING' ? 'WARN' : line.level === 'CRITICAL' ? 'CRIT' : line.level}
      </span>
      <span className="log-comp" title={line.component}>
        {line.component}
      </span>
      <span className="log-msg">
        {line.msg}
        {line.run_id ? <Link to={`/runs/${line.run_id}`}>run {line.run_id}</Link> : null}
      </span>
      {line.exc && (
        <details className="log-exc">
          <summary>Traceback</summary>
          {line.exc}
        </details>
      )}
    </div>
  )
}
