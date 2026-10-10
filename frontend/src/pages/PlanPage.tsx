import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { usePlan, usePlanHistory, useStatus } from '../api/queries'
import type { PlanRow } from '../api/types'
import { Lamp } from '../components/Lamp'
import { Empty, ErrorNotice, PageHead } from '../components/PageHead'
import { useNow } from '../components/useNow'
import { formatDuration, formatSlot, formatSlotDate, formatTime } from '../lib/format'
import {
  EXTERNAL_PLAN_NOTE,
  formatPlanCell,
  lastRunNote,
  planChanges,
  planColumnLabel,
  planColumnUnit,
  rowAt,
} from '../lib/plan'
import { planSummary } from '../lib/planSummary'
import {
  HISTORY_WINDOWS,
  HORIZON_KEY,
  HORIZON_SLOTS,
  HOURS_KEY,
  loadPref,
  savePref,
  type HistoryHours,
  type HorizonSlots,
} from '../lib/planHistory'
import { formatPower } from '../lib/units'
import { AccuracyCard } from './plan/AccuracyCard'
import { CostfunPanel } from './plan/CostfunPanel'
import { HistoryControls } from './plan/HistoryControls'
import { PlanCharts } from './plan/PlanCharts'
import { NowSlot } from './plan/NowSlot'

const DRIVERS: Record<string, string> = {
  app: 'EMHASS Lens',
  legacy: 'the HACS integration',
  external: 'someone else (not EMHASS Lens)',
}

export function PlanPage() {
  const plan = usePlan()
  const appStatus = useStatus()
  const now = useNow(15_000)
  const nowS = now.getTime() / 1000
  const data = plan.data
  const currentRows = data?.current?.rows
  const previousRows = data?.previous?.rows
  const rows = useMemo(() => (currentRows ?? []) as PlanRow[], [currentRows])
  const changes = useMemo(() => planChanges(rows, (previousRows ?? []) as PlanRow[]), [rows, previousRows])
  const [table, setTable] = useState(false)
  const [hours, setHours] = useState<HistoryHours>(() => loadPref(HOURS_KEY, HISTORY_WINDOWS, 24))
  const [horizon, setHorizon] = useState<HorizonSlots>(() => loadPref(HORIZON_KEY, HORIZON_SLOTS, 0))
  const history = usePlanHistory(hours, horizon)
  const chooseHours = (h: HistoryHours) => {
    setHours(h)
    savePref(HOURS_KEY, h)
  }
  const chooseHorizon = (h: HorizonSlots) => {
    setHorizon(h)
    savePref(HORIZON_KEY, h)
  }

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
  const lastRun = (current.last_run ?? {}) as Record<string, unknown>
  const status = typeof lastRun.status === 'string' ? lastRun.status : null
  const runNote = lastRunNote(lastRun, current.generated_at, now, tz)
  const leftover = appStatus.data?.problems.find((p) => p.key === 'costfun.leftover')
  const duration = typeof lastRun.duration_total_seconds === 'number' ? lastRun.duration_total_seconds * 1000 : null
  const first = rows[0]?.timestamp
  const last = rows[rows.length - 1]?.timestamp

  const summary = planSummary(rows, nowS, tz)
  const viewToggle = (
    <div className="segmented" role="group" aria-label="Show the plan as">
      <button type="button" aria-pressed={!table} onClick={() => setTable(false)}>
        Chart
      </button>
      <button type="button" aria-pressed={table} onClick={() => setTable(true)}>
        Table
      </button>
    </div>
  )

  return (
    <>
      <PageHead title="Plan" intro={summary ? <span className="plan-summary">{summary}</span> : undefined}>
        {viewToggle}
      </PageHead>
      <ErrorNotice error={plan.error} />
      {leftover && (
        <div className="notice" data-color="amber" role="note">
          <strong>{leftover.title}.</strong> {leftover.detail} {leftover.hint}
        </div>
      )}
      {runNote && (
        <div className="notice" data-color="amber" role="note">
          {runNote} <Link to="/runs?job=emhass.mpc">MPC runs</Link> show what EMHASS Lens sent and EMHASS's full answer.
        </div>
      )}

      <dl className="facts facts-inline">
        <div>
          <dt>Planned at</dt>
          <dd>
            <span title={runNote ?? `EMHASS said: ${status ?? 'nothing'}`}>
              <Lamp
                color={status === 'ok' ? 'green' : status ? 'amber' : 'neutral'}
                label={`EMHASS said: ${status ?? 'nothing'}`}
              />
            </span>{' '}
            <time dateTime={current.generated_at}>{formatTime(current.generated_at, now, tz)}</time>
            {current.run_id && (
              <>
                {' · '}
                <Link to={`/runs/${current.run_id}`}>run {current.run_id}</Link>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Made for</dt>
          <dd>
            {DRIVERS[current.driver] ?? current.driver}
            {current.driver === 'external' && (
              <div className="cell-sub">
                {EXTERNAL_PLAN_NOTE} <Link to="/runs?job=emhass.plan_watch">Plan watch runs</Link> show when it was
                picked up.
              </div>
            )}
          </dd>
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
            {rows.length} slots, {formatSlot(first ? String(first) : null, now, tz)} →{' '}
            {formatSlot(last ? String(last) : null, now, tz)}
          </dd>
        </div>
        <div>
          <dt>Times in</dt>
          <dd>{tz}</dd>
        </div>
      </dl>

      <NowSlot columns={data.columns} tz={tz} now={now} />

      <section className="panel">
        <div className="panel-head">
          <h2>{table ? 'The plan as a table' : 'Timeline'}</h2>
          {!table && (
            <HistoryControls hours={hours} horizon={horizon} onHours={chooseHours} onHorizon={chooseHorizon} />
          )}
        </div>
        <div className="panel-body">
          {table ? (
            <PlanTable rows={rows} columns={data.columns} nowS={nowS} timeZone={tz} />
          ) : (
            <PlanCharts data={data} history={history.data} nowS={nowS} />
          )}
        </div>
      </section>

      <div className="two-col">
        <section className="panel">
          <div className="panel-head">
            <h2>How accurate the plan has been</h2>
            {history.data?.measurements.last_sample_at && (
              <span className="muted">
                measured until {formatTime(history.data.measurements.last_sample_at, now, tz)}
              </span>
            )}
          </div>
          <div className="panel-body">
            <ErrorNotice error={history.error} />
            <AccuracyCard history={history.data} />
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Changes vs the previous plan</h2>
            {data.previous && (
              <span className="muted">previous: {formatTime(data.previous.generated_at, now, tz)}</span>
            )}
          </div>
          {!data.previous ? (
            <Empty title="No earlier plan stored yet" />
          ) : changes.length === 0 ? (
            <Empty title="No slot moved by more than 500 W">
              Battery and grid power are the same as in the previous plan.
            </Empty>
          ) : (
            <div className="table-wrap sticky-table">
              <table className="num-table">
                <thead>
                  <tr>
                    <th>Slot</th>
                    <th className="r">Battery before</th>
                    <th className="r">now</th>
                    <th className="r">Grid before</th>
                    <th className="r">now</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.slice(0, 96).map((c) => (
                    <tr key={c.time}>
                      <td className="num">{formatSlotDate(c.timestamp, tz, now)}</td>
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
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Cost functions</h2>
          <span className="muted">profit, cost and self-consumption with the same inputs</span>
        </div>
        <div className="panel-body">
          <CostfunPanel nowS={nowS} now={now} />
        </div>
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
      <table className="num-table plan-table">
        <thead>
          <tr>
            <th>Slot</th>
            {shown.map((c) => (
              <th key={c} className="r" title={`EMHASS column ${c}`}>
                <div>{planColumnLabel(c)}</div>
                <div className="th-sub">
                  {planColumnUnit(c) && `${planColumnUnit(c)} · `}
                  {c}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.timestamp)} data-current={row === current || undefined}>
              <td className="num">{formatSlotDate(String(row.timestamp), timeZone, new Date(nowS * 1000))}</td>
              {shown.map((c) => (
                <td key={c} className="num r">
                  {formatPlanCell(c, row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
