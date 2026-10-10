import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '../../api/client'
import { useLatestRun } from '../../api/queries'
import type { ParityReport } from '../../api/types'
import { OutcomeChip } from '../../components/Outcome'
import { Empty } from '../../components/PageHead'
import { ParityView } from '../../components/ParityView'
import { formatTime } from '../../lib/format'

/** The latest parity check: the HACS integration's entities and the owner's own price sensors. */
export function ParityCard() {
  const latest = useLatestRun('parity.check')
  const run = latest.data
  const report = useQuery({
    queryKey: ['artifact', run?.id, 'parity'],
    queryFn: () => api.get<ParityReport>(`/api/runs/${run?.id}/artifacts/parity`),
    enabled: Boolean(run && run.outcome !== 'noop' && run.outcome !== 'running'),
    staleTime: Infinity,
    retry: false,
  })
  return (
    <section id="card-parity" className="panel">
      <div className="panel-head">
        <h2>Parity checks</h2>
        {run && (
          <span className="toolbar">
            <OutcomeChip outcome={run.outcome} />
            <Link to={`/runs/${run.id}`}>{formatTime(run.started_at)}</Link>
          </span>
        )}
      </div>
      {!run ? (
        <Empty title="Not compared yet">
          Runs every quarter-hour at :05: the HACS integration's entities while it is installed, and your own price
          sensors from Settings → Prices → Compare with your price sensors.
        </Empty>
      ) : report.data ? (
        <div className="panel-body">
          <ParityView report={report.data} />
        </div>
      ) : (
        <div className="panel-body">
          <p className="muted" style={{ margin: 0 }}>
            {run.summary ?? 'No report for this run.'}
          </p>
        </div>
      )}
    </section>
  )
}
