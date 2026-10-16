import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { usePlan, usePlanHistory, usePlanNow, useStatus } from '../api/queries'
import type { PlanRow } from '../api/types'
import { Lamp } from '../components/Lamp'
import { Empty, ErrorNotice, PageHead } from '../components/PageHead'
import { useMediaQuery } from '../components/useMediaQuery'
import { cursorTimeLabel, dayDateLabel } from '../lib/chartTime'
import { useNow } from '../components/useNow'
import { formatEur } from '../lib/costfun'
import { formatDuration, formatSlot, formatSlotDate, formatTime } from '../lib/format'
import {
  costFunTotal,
  EXTERNAL_PLAN_NOTE,
  formatPlanCell,
  lastRunNote,
  planAge,
  planChanges,
  planColumnLabel,
  planColumnUnit,
  rowAt,
  staleNote,
} from '../lib/plan'
import { controlFact } from '../lib/planNow'
import { planSummary } from '../lib/planSummary'
import {
  HORIZON_KEY,
  HORIZON_SLOTS,
  NARROW_VIEWS,
  VIEW_HOURS,
  VIEW_KEY,
  WIDE_VIEWS,
  loadPref,
  savePref,
  viewFor,
  viewHistory,
  type HorizonSlots,
  type ViewHours,
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
  const planNow = usePlanNow() // shared with NowSlot
  const now = useNow(15_000)
  const nowS = now.getTime() / 1000
  const data = plan.data
  const currentRows = data?.current?.rows
  const previousRows = data?.previous?.rows
  const rows = useMemo(() => (currentRows ?? []) as PlanRow[], [currentRows])
  const changes = useMemo(() => planChanges(rows, (previousRows ?? []) as PlanRow[]), [rows, previousRows])
  // a phone gets its own windows (4 h, 24 h, 2 days) and charts
  const narrow = useMediaQuery('(max-width: 640px)')
  const [chosenView, setView] = useState<ViewHours>(() => loadPref(VIEW_KEY, VIEW_HOURS, 8))
  const view = viewFor(chosenView, narrow)
  const [horizon, setHorizon] = useState<HorizonSlots>(() => loadPref(HORIZON_KEY, HORIZON_SLOTS, 0))
  const history = usePlanHistory(viewHistory(view), narrow ? 0 : horizon)
  // a window picked by zooming, scrolling or the overview (unix seconds); null follows now in `view`
  const [zoom, setZoom] = useState<[number, number] | null>(null)
  const chooseView = (v: ViewHours) => {
    setView(v)
    setZoom(null)
    savePref(VIEW_KEY, v)
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
  const age = planAge(current.generated_at, data.stale_after_s, nowS)
  const stale = age?.stale ? staleNote(current.generated_at, age.ageS, now, tz) : null
  const leftover = appStatus.data?.problems.find((p) => p.key === 'costfun.leftover')
  const duration = typeof lastRun.duration_total_seconds === 'number' ? lastRun.duration_total_seconds * 1000 : null
  const first = rows[0]?.timestamp
  const last = rows[rows.length - 1]?.timestamp

  const summary = planSummary(rows, nowS, tz)
  const costFun = costFunTotal(rows)
  const control = controlFact(planNow.data?.control, now, tz)
  return (
    <>
      <PageHead title="Plan" intro={summary ? <span className="plan-summary">{summary}</span> : undefined} />
      <ErrorNotice error={plan.error} />
      {leftover && (
        <div className="notice" data-color="amber" role="note">
          <strong>{leftover.title}.</strong> {leftover.detail} {leftover.hint}
        </div>
      )}
      {stale && (
        <div className="notice" data-color="amber" role="note">
          {stale} <Link to="/runs?job=emhass.mpc">MPC runs</Link> show why.
        </div>
      )}
      {runNote && (
        <div className="notice" data-color="amber" role="note">
          {runNote} <Link to="/runs?job=emhass.mpc">MPC runs</Link> show what EMHASS Lens sent and EMHASS's full answer.
        </div>
      )}
      {current.driver !== 'app' && current.driver !== 'legacy' && (
        <div className="notice" data-color="amber" role="note">
          <strong>Requested by {DRIVERS[current.driver] ?? current.driver}.</strong> {EXTERNAL_PLAN_NOTE}{' '}
          <Link to="/runs?job=emhass.plan_watch">Plan watch runs</Link> show when it was picked up.
        </div>
      )}

      <NowSlot
        columns={data.columns}
        prices={data.prices}
        tz={tz}
        now={now}
        facts={
          <dl className="facts facts-inline">
            {control && (
              <div>
                <dt>Mode</dt>
                <dd title={control.title}>
                  <Lamp color={control.market ? 'amber' : 'green'} label={control.label} />{' '}
                  {control.market ? <Link to="/market">{control.label}</Link> : control.label}
                  {control.detail && <span className="muted"> · {control.detail}</span>}
                </dd>
              </div>
            )}
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
                {current.driver === 'legacy' && (
                  <span
                    className="muted"
                    title="Requested by the HACS integration: its Auto MPC switch was on when EMHASS Lens picked this plan up"
                  >
                    {' '}
                    · by HACS
                  </span>
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
            {costFun && (
              <div>
                <dt>Total cost function</dt>
                <dd
                  title={`Σ ${costFun.column} over the ${rows.length} slots of this plan, which EMHASS publishes as sensor.total_cost_fun_value (positive is money in)`}
                >
                  {formatEur(costFun.value)} <span className="muted">{costFun.method}</span>
                </dd>
              </div>
            )}
          </dl>
        }
      />

      <section className="panel">
        <div className="panel-head">
          <h2>
            Timeline
            {narrow && (
              <span className="timeline-now">
                {dayDateLabel(nowS, tz)} · now {cursorTimeLabel(nowS, tz, false)}
              </span>
            )}
          </h2>
          <div className="timeline-controls" data-narrow={narrow || undefined}>
            <HistoryControls
              view={view}
              horizon={horizon}
              onView={chooseView}
              onHorizon={chooseHorizon}
              windows={narrow ? NARROW_VIEWS : WIDE_VIEWS}
              narrow={narrow}
            />
            <button
              type="button"
              className="follow-now"
              aria-pressed={zoom === null}
              title={zoom === null ? 'The charts follow the clock' : 'Show the window around now again'}
              onClick={() => setZoom(null)}
            >
              <span className="follow-dot" data-live={zoom === null || undefined} aria-hidden="true" />
              {zoom === null ? 'Following now' : 'Back to now'}
            </button>
          </div>
        </div>
        <div className="panel-body">
          <PlanCharts
            data={data}
            history={history.data}
            nowS={nowS}
            view={view}
            horizon={narrow ? 0 : horizon}
            narrow={narrow}
            zoom={zoom}
            onZoom={setZoom}
            loading={history.isPlaceholderData}
            stale={age?.stale ?? false}
          />
          <details className="table-around">
            <summary>Every column of this plan</summary>
            <PlanTable rows={rows} columns={data.columns} nowS={nowS} timeZone={tz} />
          </details>
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
