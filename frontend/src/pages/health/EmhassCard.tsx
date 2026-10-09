import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '../../api/client'
import { keys, useEmhass } from '../../api/queries'
import type { EmhassStatus, RunStarted } from '../../api/types'
import { ChecksTable } from '../../components/ChecksTable'
import { LabelledLamp } from '../../components/Lamp'
import { ErrorNotice } from '../../components/PageHead'
import { formatTime } from '../../lib/format'

export function EmhassCard({ writable }: { writable: boolean }) {
  const emhass = useEmhass()
  const queryClient = useQueryClient()
  const discover = useMutation({
    mutationFn: () => api.post<EmhassStatus>('/api/emhass/discover'),
    onSuccess: (data) => queryClient.setQueryData(keys.emhass, data),
  })
  const check = useMutation({
    mutationFn: () => api.post<RunStarted>('/api/emhass/check'),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.emhass }),
  })
  const e = emhass.data
  const checks = e?.checks ?? []
  const discovery = e?.discovery ?? []

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>EMHASS</h2>
        <div className="toolbar">
          <button type="button" disabled={!writable || discover.isPending} onClick={() => discover.mutate()}>
            {discover.isPending ? 'Searching…' : 'Search again'}
          </button>
          <button type="button" disabled={!writable || check.isPending} onClick={() => check.mutate()}>
            Re-check configuration
          </button>
        </div>
      </div>
      <div className="panel-body">
        <ErrorNotice error={emhass.error ?? discover.error ?? check.error} />
        {check.data?.run_id && (
          <div className="notice">
            Checking… <Link to={`/runs/${check.data.run_id}`}>run #{check.data.run_id}</Link>
          </div>
        )}
        {e && (
          <dl className="facts">
            <div>
              <dt>Status</dt>
              <dd>
                <LabelledLamp
                  color={e.reachable === true ? 'green' : e.reachable === false ? 'red' : 'neutral'}
                  text={e.reachable === true ? 'Reachable' : e.reachable === false ? 'Unreachable' : 'Not checked yet'}
                />
              </dd>
            </div>
            <div>
              <dt>Address</dt>
              <dd className="wrap">
                {e.url ? <code>{e.url}</code> : '—'}
                <div className="cell-sub">
                  {e.url_source === 'settings' ? 'from Settings' : e.url_source === 'discovered' ? 'found automatically' : 'not found'}
                </div>
              </dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{e.version ?? '—'}</dd>
            </div>
            <div>
              <dt>Start rounding</dt>
              <dd>{e.method_ts_round}</dd>
            </div>
            <div>
              <dt>Last health check</dt>
              <dd>{formatTime(e.last_health_at)}</dd>
            </div>
            <div>
              <dt>Configuration read</dt>
              <dd>{formatTime(e.config_at)}</dd>
            </div>
          </dl>
        )}
        {e?.last_error && (
          <div className="error-box">
            {e.last_error}
            {e.unreachable_since && <div className="cell-sub">since {formatTime(e.unreachable_since)}</div>}
          </div>
        )}
        {discovery.length > 0 && (
          <details className="card-explain" style={{ marginTop: 12 }}>
            <summary>Where EMHASS Lens looked ({discovery.length})</summary>
            <ul className="plain-list">
              {discovery.map((d) => (
                <li key={d.url}>
                  <LabelledLamp color={d.ok ? 'green' : 'red'} text={d.url} />{' '}
                  <span className="cell-sub">{d.ok ? `EMHASS ${d.version ?? ''}` : d.error}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      {checks.length > 0 && (
        <>
          <div className="panel-head panel-subhead">
            <h3>Configuration checks</h3>
            <span className="muted">What EMHASS Lens relies on vs EMHASS's effective configuration</span>
          </div>
          <ChecksTable checks={checks} />
        </>
      )}
    </section>
  )
}
