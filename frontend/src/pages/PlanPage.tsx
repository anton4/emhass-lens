import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useOutputs, usePlan } from '../api/queries'
import type { PlanRow } from '../api/types'
import { LabelledLamp } from '../components/Lamp'
import { Empty, ErrorNotice, PageHead } from '../components/PageHead'
import { useNow } from '../components/useNow'
import { formatClock, formatDuration, formatSlot, formatTime } from '../lib/format'
import { inCurrentSlot } from '../lib/publish'
import { planChanges, rowAt } from '../lib/plan'
import { formatPower } from '../lib/units'
import { PlanCharts } from './plan/PlanCharts'
import { ThisSlot } from './plan/ThisSlot'

const DRIVERS: Record<string, string> = {
  app: 'EMHASS Lens',
  legacy: 'the HACS integration',
  external: 'someone else (not EMHASS Lens)',
}

export function PlanPage() {
  const plan = usePlan()
  const outputs = useOutputs()
  const now = useNow(15_000)
  const nowS = now.getTime() / 1000
  const data = plan.data
  const currentRows = data?.current?.rows
  const previousRows = data?.previous?.rows
  const rows = useMemo(() => (currentRows ?? []) as PlanRow[], [currentRows])
  const changes = useMemo(() => planChanges(rows, (previousRows ?? []) as PlanRow[]), [rows, previousRows])
  const [table, setTable] = useState(false)

  if (plan.isLoading) return <PageHead title="Plan" />
  if (!data?.available || !data.current) {
    return (
      <>
        <PageHead title="Plan" intro="What EMHASS wants the battery, grid and loads to do in each quarter-hour." />
        <ErrorNotice error={plan.error} />
        <section className="panel">
          <Empty title="No EMHASS plan yet">
            In shadow mode EMHASS Lens shows the plans EMHASS makes for whoever drives it, for example the HACS
            integration. Check <Link to="/health">Health → EMHASS</Link> to see whether EMHASS is reachable.
          </Empty>
        </section>
      </>
    )
  }

  const current = data.current
  const tz = data.timezone
  const publishedAt = outputs.data?.last_published_at
  const lastRun = (current.last_run ?? {}) as Record<string, unknown>
  const status = typeof lastRun.status === 'string' ? lastRun.status : null
  const duration = typeof lastRun.duration_total_seconds === 'number' ? lastRun.duration_total_seconds * 1000 : null
  const currentRow = (data.current_row as PlanRow | null) ?? rowAt(rows, nowS)
  const first = rows[0]?.timestamp
  const last = rows[rows.length - 1]?.timestamp

  return (
    <>
      <PageHead title="Plan" intro="What EMHASS wants the battery, grid and loads to do in each quarter-hour.">
        <div className="toolbar">
          <LabelledLamp color={status === 'ok' ? 'green' : status ? 'amber' : 'neutral'} text={`EMHASS ${status ?? '—'}`} />
        </div>
      </PageHead>
      <ErrorNotice error={plan.error} />

      <section className="panel">
        <div className="panel-body">
          <dl className="facts">
            <div>
              <dt>Planned at</dt>
              <dd>
                <time dateTime={current.generated_at}>{formatTime(current.generated_at, now, tz)}</time>
              </dd>
            </div>
            <div>
              <dt>Made for</dt>
              <dd>{DRIVERS[current.driver] ?? current.driver}</dd>
            </div>
            {duration !== null && (
              <div>
                <dt>Solve took</dt>
                <dd>{formatDuration(duration)}</dd>
              </div>
            )}
            <div>
              <dt>Horizon</dt>
              <dd>
                {rows.length} slots
                <div className="cell-sub">
                  {formatTime(first, now, tz)} → {formatTime(last, now, tz)}
                </div>
              </dd>
            </div>
            <div>
              <dt>Times in</dt>
              <dd>{tz}</dd>
            </div>
            {current.run_id && (
              <div>
                <dt>Run</dt>
                <dd>
                  <Link to={`/runs/${current.run_id}`}>#{current.run_id}</Link>
                </dd>
              </div>
            )}
          </dl>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>This slot</h2>
          {currentRow?.timestamp && <span className="muted">from {formatSlot(String(currentRow.timestamp), now, tz)}</span>}
        </div>
        <div className="panel-body">
          {currentRow ? (
            <ThisSlot row={currentRow} columns={data.columns} />
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              The plan doesn't cover the current quarter-hour (it starts {formatTime(first, now, tz)}).
            </p>
          )}
          {inCurrentSlot(publishedAt, now) && (
            <p className="published-note">
              Published to Home Assistant at {formatClock(publishedAt, tz)} (EMHASS sensors and the{' '}
              <code>emhass_lens_plan_published</code> event).
            </p>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Plan</h2>
          <button type="button" className="quiet" aria-pressed={table} onClick={() => setTable((t) => !t)}>
            {table ? 'Show charts' : 'Show as a table'}
          </button>
        </div>
        <div className="panel-body">{table ? <PlanTable rows={rows} columns={data.columns} nowS={nowS} timeZone={tz} /> : <PlanCharts data={data} nowS={nowS} />}</div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Changes vs the previous plan</h2>
          {data.previous && <span className="muted">previous: {formatTime(data.previous.generated_at, now, tz)}</span>}
        </div>
        {!data.previous ? (
          <Empty title="No earlier plan stored yet" />
        ) : changes.length === 0 ? (
          <Empty title="No slot moved by more than 500 W">Battery and grid power are the same as in the previous plan.</Empty>
        ) : (
          <div className="table-wrap sticky-table">
            <table className="num-table">
              <thead>
                <tr>
                  <th>Slot</th>
                  <th className="r">Battery before</th>
                  <th className="r">Battery now</th>
                  <th className="r">Grid before</th>
                  <th className="r">Grid now</th>
                </tr>
              </thead>
              <tbody>
                {changes.slice(0, 96).map((c) => (
                  <tr key={c.time}>
                    <td className="num">{formatSlot(c.timestamp, now, tz)}</td>
                    <td className="num r">{formatPower(c.battBefore)}</td>
                    <td className="num r">{formatPower(c.battNow)}</td>
                    <td className="num r">{formatPower(c.gridBefore)}</td>
                    <td className="num r">{formatPower(c.gridNow)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}

function PlanTable({
  rows,
  columns,
  nowS,
  timeZone,
}: {
  rows: PlanRow[]
  columns: string[]
  nowS: number
  timeZone: string
}) {
  const shown = columns.filter((c) => !c.startsWith('cost_fun_'))
  const current = rowAt(rows, nowS)
  return (
    <div className="table-wrap sticky-table">
      <table className="num-table">
        <thead>
          <tr>
            <th>Slot</th>
            {shown.map((c) => (
              <th key={c} className="r">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.timestamp)} data-current={row === current || undefined}>
              <td className="num">{formatSlot(String(row.timestamp), new Date(nowS * 1000), timeZone)}</td>
              {shown.map((c) => {
                const v = row[c]
                return (
                  <td key={c} className="num r">
                    {typeof v === 'number' ? (c.startsWith('SOC_opt') ? `${(v * 100).toFixed(1)} %` : Math.abs(v) >= 10 ? Math.round(v) : v.toFixed(4)) : String(v ?? '—')}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
