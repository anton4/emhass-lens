import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useMarketReconcile } from '../api/actions'
import { useMarket, useMarketSessions, useRuns, useSettings, useStatus } from '../api/queries'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { AgreeHeadline, CompareTable } from '../components/InverterViews'
import { Lamp, LabelledLamp } from '../components/Lamp'
import { ActionChip, CommandFacts, MarketDecisionView, MarketExplainer, WearFacts } from '../components/MarketViews'
import { OutcomeChip } from '../components/Outcome'
import { AgreementFact } from '../components/controller/AgreementFact'
import { CompareChip } from '../components/controller/CompareChip'
import { ControllerHead } from '../components/controller/ControllerHead'
import { DayStrip } from '../components/controller/DayStrip'
import { Empty, ErrorNotice } from '../components/PageHead'
import { useNow } from '../components/useNow'
import { dayBounds, todayKey } from '../lib/days'
import { holdUntilNext, type StripInput } from '../lib/dayStrip'
import { formatDateTime, formatTime } from '../lib/format'
import { runFilters, useListParams } from '../lib/listParams'
import { matchesSearch, nextSort, sortRows } from '../lib/sort'
import { ListControls } from '../components/ListControls'
import { SortableTh } from '../components/SortableTh'
import {
  MARKET_FIELD_LABELS,
  marketFieldValue,
  marketModeSpec,
  pairMarketCompares,
  parseReconcileSummary,
  sessionText,
  type MarketComparison,
  type MarketLast,
  type MarketSensors,
} from '../lib/market'
import type { RunSummary } from '../api/types'

const MODES = [
  { id: 'off', text: 'Off' },
  { id: 'shadow', text: 'Shadow' },
  { id: 'live', text: 'Live' },
]

/** A reconcile run's gist, short enough to name above the day strip. */
function stripLabel(summary: string | null | undefined): string | null {
  const parsed = parseReconcileSummary(summary)
  if (!parsed) return null
  if (parsed.kind === 'command') return parsed.text
  if (parsed.kind === 'none') return 'no action'
  if (parsed.kind === 'end') return 'session end'
  return null
}

/** Qilowatt market control (experimental): the current command and session, what EMHASS Lens decides, whether the
 * Home Assistant automation did the same, and how often the inverter gets written. */
export function MarketPage() {
  const market = useMarket()
  const status = useStatus()
  const settings = useSettings()
  const reconcile = useMarketReconcile()
  const navigate = useNavigate()
  const now = useNow(60_000)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const data = market.data
  const tz = status.data?.timezone
  const writable = status.data?.writable ?? false
  const last = (data?.last ?? null) as MarketLast | null
  const lastCompare = (data?.last_compare ?? null) as MarketComparison | null
  const sensors = data?.sensors as MarketSensors | undefined
  const thresholds = settings.data?.settings.market.thresholds

  const today = todayKey(tz, now)
  const todayReconciles = useRuns(runFilters('market.reconcile', today, tz, 0))
  const todayCompares = useRuns(runFilters('market.compare', today, tz, 0))
  const strip = useMemo<StripInput[]>(
    () =>
      holdUntilNext(
        pairMarketCompares(todayReconciles.data ?? [], todayCompares.data ?? []).map((row) => ({
          t: Date.parse(row.at) / 1000,
          compare: row.compare?.outcome,
          label: stripLabel(row.reconcile?.summary),
          runId: row.reconcile?.id ?? row.compare?.id,
        })),
        900,
      ),
    [todayReconciles.data, todayCompares.data],
  )

  return (
    <>
      <ControllerHead
        title="Market"
        section="market"
        mode={data?.mode}
        modes={MODES}
        spec={marketModeSpec}
        automation="Qilowatt: Master Market Controller"
        liveNotice={
          <>
            <strong>EMHASS Lens runs the market sessions.</strong> Make sure the automation "Qilowatt: Master Market
            Controller" is off, or both will write to the inverter.
          </>
        }
        writable={writable}
        actions={
          <>
            <button
              type="button"
              className="primary"
              disabled={!writable || reconcile.isPending}
              onClick={() =>
                reconcile.mutate({}, { onSuccess: (started) => started.run_id && navigate(`/runs/${started.run_id}`) })
              }
              title={data?.mode === 'live' ? 'Reconciles now and acts' : 'Shows what it would do now'}
            >
              {reconcile.isPending ? 'Reconciling…' : 'Reconcile now'}
            </button>
            {data?.mode === 'live' && data.session && (
              <button
                type="button"
                className="danger"
                disabled={!writable || reconcile.isPending}
                onClick={() => setConfirmEnd(true)}
              >
                End session now
              </button>
            )}
            <Link className="button" to="/settings?section=market">
              Settings
            </Link>
          </>
        }
      >
        <div>
          <dt>In control</dt>
          <dd>
            {!data || data.mode !== 'live' ? (
              <span className="faint">—</span>
            ) : data.preconditions ? (
              <LabelledLamp color="amber" text="Not now" />
            ) : (
              <LabelledLamp color="green" text="EMHASS Lens is in control" />
            )}
            {data?.preconditions && <div className="cell-sub">{data.preconditions}</div>}
          </dd>
        </div>
        <AgreementFact title="Agreement, 24 h" agreement={data?.agreement_24h} per="decision" />
        <AgreementFact title="Agreement, 7 days" agreement={data?.agreement_7d} per="decision" />
        <WearFacts day={data?.wear_24h} week={data?.wear_7d} />
      </ControllerHead>
      <ErrorNotice error={market.error ?? reconcile.error} />
      {data?.notice && (
        <div className="notice" data-color="amber" role="note">
          {data.notice}
        </div>
      )}

      <DayStrip
        inputs={strip}
        span={900}
        timeZone={tz}
        what="decision"
        empty={
          data?.mode === 'off'
            ? 'Market control is off, so nothing is decided. Switch to Shadow to compare with the automation.'
            : 'No decisions yet today.'
        }
      />

      <section className="panel">
        <div className="panel-head">
          <h2>Live command</h2>
        </div>
        <div className="panel-body">
          <CommandFacts sensors={sensors} session={data?.session} tz={tz} />
        </div>
      </section>

      <div className="two-col">
        <section className="panel">
          <div className="panel-head">
            <h2>Last decision</h2>
            {last && (
              <span className="muted">
                {formatTime(last.at, new Date(), tz)} · {last.trigger}
                {last.run_id !== null && (
                  <>
                    {' '}
                    · <Link to={`/runs/${last.run_id}`}>run {last.run_id}</Link>
                  </>
                )}
              </span>
            )}
          </div>
          <div className="panel-body">
            {!last ? (
              <Empty title="No decision yet">
                {data?.mode === 'off'
                  ? 'Market control is off. Use Reconcile now to see what it would do.'
                  : 'The next decision comes with the next command change or minute tick.'}
              </Empty>
            ) : (
              <>
                {last.blocked && (
                  <div className="notice" data-color="amber" role="note">
                    Not in control: {last.blocked}. This is what it would have done.
                  </div>
                )}
                <MarketDecisionView decision={last.decision} sessionBefore={last.session_before} />
              </>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Last comparison</h2>
            {lastCompare?.decision_run_id !== undefined && (
              <span className="muted">
                <Link to={`/runs/${lastCompare.decision_run_id}`}>decision run {lastCompare.decision_run_id}</Link>
              </span>
            )}
          </div>
          <div className="panel-body">
            {!lastCompare ? (
              <Empty title="Nothing compared yet">
                In shadow mode, each decision is compared a few seconds later with what the Home Assistant automation
                did.
              </Empty>
            ) : (
              <>
                <p style={{ marginTop: 0 }}>
                  <AgreeHeadline comparison={lastCompare} what="Automation vs EMHASS Lens" />
                </p>
                <CompareTable
                  comparison={lastCompare}
                  observedLabel="Home Assistant shows"
                  labels={MARKET_FIELD_LABELS}
                  format={marketFieldValue}
                />
              </>
            )}
          </div>
        </section>
      </div>

      <MarketExplainer thresholds={thresholds} />

      <SessionsTable tz={tz} />
      <MarketHistory timeZone={tz} />

      <ConfirmDialog
        open={confirmEnd}
        title="End the market session now?"
        onClose={() => setConfirmEnd(false)}
        actions={[
          {
            label: 'End session',
            kind: 'danger',
            disabled: reconcile.isPending,
            onClick: () =>
              reconcile.mutate(
                { force_end: true },
                {
                  onSettled: () => setConfirmEnd(false),
                  onSuccess: (started) => started.run_id && navigate(`/runs/${started.run_id}`),
                },
              ),
          },
        ]}
      >
        <p>
          The session {sessionText(data?.session)} ends whatever Qilowatt says: the session select goes to none, the
          EMHASS automation switch comes back on, and the inverter gets this slot's plan (or the safe state).
        </p>
      </ConfirmDialog>
    </>
  )
}

function SessionsTable({ tz }: { tz?: string }) {
  const [list, setList] = useListParams('ms.', { key: 'started', dir: 'desc' })
  const sessions = useMarketSessions(list.day ? dayBounds(list.day, tz) : {})
  const all = sessions.data ?? []
  const shown = sortRows(
    all.filter(
      (s) =>
        (!list.filter || s.direction === list.filter) &&
        matchesSearch([s.direction, s.source, s.mode, s.end_reason], list.q),
    ),
    (s) =>
      list.sort.key === 'ended'
        ? s.ended_at
          ? Date.parse(s.ended_at)
          : null
        : list.sort.key === 'power'
          ? s.power_w
          : list.sort.key === 'direction'
            ? s.direction
            : Date.parse(s.started_at),
    list.sort.dir,
  )
  const onSort = (key: string) => setList({ sort: nextSort(list.sort, key, key === 'direction' ? 'asc' : 'desc') })
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Sessions</h2>
        <span className="muted">Run by EMHASS Lens in live mode{list.day ? `, started on ${list.day}` : ''}</span>
      </div>
      <div className="panel-body">
        <ListControls
          value={list}
          onChange={setList}
          timeZone={tz}
          filterLabel="Directions"
          filterOptions={[
            { value: 'buy', label: 'buy' },
            { value: 'sell', label: 'sell' },
          ]}
          shown={`${shown.length} of ${all.length}`}
        />
        <ErrorNotice error={sessions.error} />
      </div>
      {shown.length === 0 ? (
        <div className="panel-body">
          <Empty title={all.length === 0 ? 'No sessions for this choice' : 'Nothing matches the filters'} />
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortableTh label="Started" sortKey="started" sort={list.sort} onSort={onSort} />
                <SortableTh label="Direction" sortKey="direction" sort={list.sort} onSort={onSort} />
                <th>Source</th>
                <SortableTh label="Power" sortKey="power" sort={list.sort} onSort={onSort} />
                <SortableTh label="Ended" sortKey="ended" sort={list.sort} onSort={onSort} />
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.id}>
                  <td className="num">{formatDateTime(s.started_at, tz)}</td>
                  <td>
                    <ActionChip action={s.direction} />
                  </td>
                  <td>{s.source ?? '—'}</td>
                  <td className="num">{s.power_w !== null ? `${s.power_w} W` : '—'}</td>
                  <td className="num">{s.ended_at ? formatDateTime(s.ended_at, tz) : 'open'}</td>
                  <td>{s.end_reason?.replace('_', ' ') ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** Recent reconciles: what was decided and whether the automation did the same. */
function MarketHistory({ timeZone }: { timeZone?: string }) {
  const [list, setList] = useListParams('d.', { key: 'at', dir: 'desc' })
  const reconciles = useRuns(runFilters('market.reconcile', list.day, timeZone, 60))
  const compares = useRuns(runFilters('market.compare', list.day, timeZone, 60))
  const all = pairMarketCompares(reconciles.data ?? [], compares.data ?? []).map((row) => ({
    row,
    parsed: parseReconcileSummary(row.reconcile?.summary),
  }))
  const kinds = [
    ...new Set(all.map((r) => r.parsed?.kind as string | undefined).filter((k): k is string => Boolean(k))),
  ].sort()
  const shown = sortRows(
    all.filter(
      ({ row, parsed }) =>
        (!list.filter || parsed?.kind === list.filter) &&
        (!list.mismatch || row.compare?.outcome === 'mismatch') &&
        matchesSearch([row.reconcile?.summary, row.compare?.summary, row.reconcile?.trigger], list.q),
    ),
    ({ row, parsed }) =>
      list.sort.key === 'decision'
        ? parsed?.text
        : list.sort.key === 'automation'
          ? row.compare?.outcome
          : Date.parse(row.at),
    list.sort.dir,
  )
  const onSort = (key: string) => setList({ sort: nextSort(list.sort, key, key === 'at' ? 'desc' : 'asc') })
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Recent decisions</h2>
        <span className="muted">{list.day ? `All of ${list.day}` : 'The latest reconciles and comparisons'}</span>
      </div>
      <div className="panel-body">
        <ListControls
          value={list}
          onChange={setList}
          timeZone={timeZone}
          filterLabel="Kinds"
          filterOptions={kinds.map((k) => ({ value: k, label: k }))}
          mismatchLabel="Only where the automation differed"
          shown={`${shown.length} of ${all.length}`}
        />
        <ErrorNotice error={reconciles.error ?? compares.error} />
      </div>
      {shown.length === 0 ? (
        <div className="panel-body">
          <Empty title={all.length === 0 ? 'No decisions recorded for this choice' : 'Nothing matches the filters'} />
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortableTh label="When" sortKey="at" sort={list.sort} onSort={onSort} />
                <th>Run</th>
                <SortableTh label="Decision" sortKey="decision" sort={list.sort} onSort={onSort} />
                <SortableTh label="Automation" sortKey="automation" sort={list.sort} onSort={onSort} />
              </tr>
            </thead>
            <tbody>
              {shown.map(({ row, parsed }) => (
                <tr key={`${row.reconcile?.id ?? 'c'}-${row.compare?.id ?? 'd'}`}>
                  <td className="num">{formatDateTime(row.at, timeZone)}</td>
                  <td>
                    {row.reconcile ? (
                      <Link to={`/runs/${row.reconcile.id}`}>
                        <ReconcileChip run={row.reconcile} />
                      </Link>
                    ) : (
                      <span className="faint">—</span>
                    )}
                    {row.reconcile && <div className="cell-sub">{row.reconcile.trigger}</div>}
                  </td>
                  <td className="wrap">{parsed ? parsed.text : <span className="faint">—</span>}</td>
                  <td>
                    {row.compare ? (
                      <Link to={`/runs/${row.compare.id}`} title={row.compare.summary ?? undefined}>
                        <CompareChip outcome={row.compare.outcome} />
                      </Link>
                    ) : (
                      <span className="faint">—</span>
                    )}
                    {row.compare?.outcome === 'mismatch' && row.compare.summary && (
                      <div className="cell-sub">{row.compare.summary.replace(/^Decision #\d+: differs — /, '')}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="panel-body cell-sub">Times in {timeZone ?? "your browser's timezone"}.</div>
    </section>
  )
}

function ReconcileChip({ run }: { run: RunSummary }) {
  if (run.outcome === 'noop' && run.summary?.startsWith('Not in control')) {
    return (
      <span className="chip" data-color="amber">
        <Lamp color="amber" />
        Not in control
      </span>
    )
  }
  return <OutcomeChip outcome={run.outcome} />
}
