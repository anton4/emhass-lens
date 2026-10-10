import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useMarketReconcile } from '../api/actions'
import { useMarket, useMarketSessions, useRuns, useSettings, useStatus } from '../api/queries'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { AgreeHeadline, CompareTable } from '../components/InverterViews'
import { Lamp, LabelledLamp } from '../components/Lamp'
import { ActionChip, CommandFacts, MarketDecisionView, MarketExplainer, WearFacts } from '../components/MarketViews'
import { OutcomeChip } from '../components/Outcome'
import { Empty, ErrorNotice, PageHead } from '../components/PageHead'
import { dayBounds } from '../lib/days'
import { formatDateTime, formatTime } from '../lib/format'
import { runFilters, useListParams } from '../lib/listParams'
import { matchesSearch, nextSort, sortRows } from '../lib/sort'
import { ListControls } from '../components/ListControls'
import { SortableTh } from '../components/SortableTh'
import { formatAgreement } from '../lib/inverter'
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
import type { Agreement, RunSummary } from '../api/types'

/** Qilowatt market control (experimental): the current command and session, what EMHASS Lens decides, whether the
 * Home Assistant automation did the same, and how often the inverter gets written. */
export function MarketPage() {
  const market = useMarket()
  const status = useStatus()
  const settings = useSettings()
  const reconcile = useMarketReconcile()
  const navigate = useNavigate()
  const [confirmEnd, setConfirmEnd] = useState(false)
  const data = market.data
  const tz = status.data?.timezone
  const writable = status.data?.writable ?? false
  const mode = marketModeSpec(data?.mode)
  const last = (data?.last ?? null) as MarketLast | null
  const lastCompare = (data?.last_compare ?? null) as MarketComparison | null
  const sensors = data?.sensors as MarketSensors | undefined
  const thresholds = settings.data?.settings.market.thresholds

  return (
    <>
      <PageHead
        title="Market"
        intro={
          <>
            Experimental. Kratt and Fusebox activations (through Qilowatt) run as sessions on the inverter. Shadow mode
            shows what EMHASS Lens would do and how often that matches your Home Assistant automation; live mode runs
            the sessions itself and hands the inverter straight back to the plan when they end.
          </>
        }
      >
        <div className="action-row" style={{ margin: 0 }}>
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
            <button type="button" className="danger" disabled={!writable || reconcile.isPending} onClick={() => setConfirmEnd(true)}>
              End session now
            </button>
          )}
          <Link className="button" to="/settings?section=market">
            Settings
          </Link>
        </div>
      </PageHead>
      <ErrorNotice error={market.error ?? reconcile.error} />
      {data?.notice && (
        <div className="notice" data-color="amber" role="note">
          {data.notice}
        </div>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>Status</h2>
          <LabelledLamp color={mode.color} text={mode.text} />
        </div>
        <div className="panel-body">
          <p style={{ marginTop: 0 }}>
            {mode.explain} Change the mode under <Link to="/settings?section=market">Settings → Qilowatt market control</Link>.
          </p>
          {data?.mode === 'live' && (
            <div className="notice" data-color="amber" role="note">
              <strong>EMHASS Lens runs the market sessions.</strong> Make sure the automation "Qilowatt: Master Market
              Controller" is off, or both will write to the inverter.
            </div>
          )}
          <dl className="facts">
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
            <AgreementFact title="Agreement, 24 h" agreement={data?.agreement_24h} />
            <AgreementFact title="Agreement, 7 days" agreement={data?.agreement_7d} />
            <WearFacts day={data?.wear_24h} week={data?.wear_7d} />
          </dl>
        </div>
      </section>

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
                {data?.mode === 'off' ? 'Market control is off. Use Reconcile now to see what it would do.' : 'The next decision comes with the next command change or minute tick.'}
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
                In shadow mode, each decision is compared a few seconds later with what the Home Assistant automation did.
              </Empty>
            ) : (
              <>
                <p style={{ marginTop: 0 }}>
                  <AgreeHeadline comparison={lastCompare} what="Automation vs EMHASS Lens" />
                </p>
                <CompareTable comparison={lastCompare} observedLabel="Home Assistant shows" labels={MARKET_FIELD_LABELS} format={marketFieldValue} />
              </>
            )}
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-body">
          <MarketExplainer thresholds={thresholds} />
        </div>
      </section>

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
                { onSettled: () => setConfirmEnd(false), onSuccess: (started) => started.run_id && navigate(`/runs/${started.run_id}`) },
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

function AgreementFact({ title, agreement }: { title: string; agreement: Agreement | undefined }) {
  const a = formatAgreement(agreement)
  return (
    <div>
      <dt>{title}</dt>
      <dd>
        <span className="readout agreement-value">{a.percent}</span>
        <div className="cell-sub">
          {agreement && agreement.compared > 0 ? <LabelledLamp color={a.color} text={a.text.replace('slots', 'decisions').replace('slot ', 'decision ')} /> : a.text}
        </div>
      </dd>
    </div>
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

function CompareChip({ outcome }: { outcome: string }) {
  if (outcome === 'ok' || outcome === 'mismatch') {
    const same = outcome === 'ok'
    return (
      <span className="chip" data-color={same ? 'green' : 'amber'}>
        <Lamp color={same ? 'green' : 'amber'} />
        {same ? 'Same' : 'Differs'}
      </span>
    )
  }
  return <OutcomeChip outcome={outcome} />
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
