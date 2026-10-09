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
import { formatTime } from '../lib/format'
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
import type { Agreement, MarketSession, RunSummary } from '../api/types'

/** Qilowatt market control (experimental): the current command and session, what EMHASS Lens decides, whether the
 * Home Assistant automation did the same, and how often the inverter gets written. */
export function MarketPage() {
  const market = useMarket()
  const sessions = useMarketSessions()
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

      <SessionsTable sessions={sessions.data ?? []} tz={tz} />
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

function SessionsTable({ sessions, tz }: { sessions: MarketSession[]; tz?: string }) {
  const now = new Date()
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Sessions</h2>
        <span className="muted">Run by EMHASS Lens in live mode, newest first</span>
      </div>
      {sessions.length === 0 ? (
        <div className="panel-body">
          <Empty title="No sessions yet" />
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Direction</th>
                <th>Source</th>
                <th>Power</th>
                <th>Ended</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="num">{formatTime(s.started_at, now, tz)}</td>
                  <td>
                    <ActionChip action={s.direction} />
                  </td>
                  <td>{s.source ?? '—'}</td>
                  <td className="num">{s.power_w !== null ? `${s.power_w} W` : '—'}</td>
                  <td className="num">{s.ended_at ? formatTime(s.ended_at, now, tz) : 'open'}</td>
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
  const reconciles = useRuns({ job: 'market.reconcile', limit: 60 })
  const compares = useRuns({ job: 'market.compare', limit: 60 })
  const rows = pairMarketCompares(reconciles.data ?? [], compares.data ?? [])
  const now = new Date()
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Recent decisions</h2>
        <span className="muted">Reconciles and comparisons, newest first</span>
      </div>
      <ErrorNotice error={reconciles.error ?? compares.error} />
      {rows.length === 0 ? (
        <div className="panel-body">
          <Empty title="No decisions recorded yet" />
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Run</th>
                <th>Decision</th>
                <th>Automation</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const parsed = parseReconcileSummary(row.reconcile?.summary)
                return (
                  <tr key={`${row.reconcile?.id ?? 'c'}-${row.compare?.id ?? 'd'}`}>
                    <td className="num">{formatTime(row.at, now, timeZone)}</td>
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
                )
              })}
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
