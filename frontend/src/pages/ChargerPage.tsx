import { Link, useNavigate } from 'react-router'
import { useChargeMode, useChargerDecide } from '../api/actions'
import { useCharger, useRuns, useSettings, useStatus } from '../api/queries'
import { ChargerDecisionView, ChargerRulesExplainer, SolarFacts } from '../components/ChargerViews'
import { AgreeHeadline, CompareTable } from '../components/InverterViews'
import { Lamp, LabelledLamp } from '../components/Lamp'
import { OutcomeChip } from '../components/Outcome'
import { Empty, ErrorNotice, PageHead } from '../components/PageHead'
import {
  CHARGER_FIELD_LABELS,
  chargerFieldValue,
  chargerModeSpec,
  pairCompares,
  parseChargerSummary,
  socClockText,
  type ChargerComparison,
  type ChargerLast,
  type ChargerTick,
  type SocClock,
} from '../lib/charger'
import { evReserveText } from '../lib/evReserve'
import { formatTime } from '../lib/format'
import { formatAgreement } from '../lib/inverter'
import type { Agreement, RunSummary } from '../api/types'

/** EV charger control (experimental): what EMHASS Lens decides for the charger, and whether the Home Assistant
 * automation did the same. */
export function ChargerPage() {
  const charger = useCharger()
  const status = useStatus()
  const settings = useSettings()
  const decide = useChargerDecide()
  const chargeMode = useChargeMode()
  const navigate = useNavigate()
  const data = charger.data
  const tz = status.data?.timezone
  const writable = status.data?.writable ?? false
  const mode = chargerModeSpec(data?.mode)
  const last = (data?.last ?? null) as ChargerLast | null
  const lastCompare = (data?.last_compare ?? null) as ChargerComparison | null
  const tick = (data?.last_tick ?? null) as ChargerTick | null
  const soc = data?.soc as SocClock | undefined
  const limits = settings.data?.settings.charger.limits

  return (
    <>
      <PageHead
        title="EV charger"
        intro={
          <>
            Experimental. What EMHASS Lens would do with the EV charger, following the plan's EV power or the excess
            solar, and how often that matches what your Home Assistant automation does. Agreement is the number to watch
            before letting EMHASS Lens drive the charger. The charge mode buttons set your Home Assistant helper, which
            the automation reads as well.
          </>
        }
      >
        <div className="action-row" style={{ margin: 0 }}>
          {data?.charge_mode && (
            <div
              className="segmented"
              role="group"
              aria-label="Charge mode"
              title={data.charge_mode.current ? `${data.charge_mode.entity}: the helper your automation reads too` : 'The charge mode helper has no state yet'}
            >
              {data.charge_mode.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={option === data.charge_mode?.current}
                  disabled={!writable || chargeMode.isPending || !data.charge_mode?.current}
                  onClick={() => chargeMode.mutate(option)}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className="primary"
            disabled={!writable || decide.isPending}
            onClick={() =>
              decide.mutate(undefined, { onSuccess: (started) => started.run_id && navigate(`/runs/${started.run_id}`) })
            }
            title={data?.mode === 'live' ? 'Decides and applies now' : 'Decides now without touching the charger'}
          >
            {decide.isPending ? 'Deciding…' : 'Decide now'}
          </button>
          <Link className="button" to="/settings?section=charger">
            Settings
          </Link>
        </div>
      </PageHead>
      <ErrorNotice error={charger.error ?? decide.error ?? chargeMode.error} />

      <section className="panel">
        <div className="panel-head">
          <h2>Status</h2>
          <LabelledLamp color={mode.color} text={mode.text} />
        </div>
        <div className="panel-body">
          <p style={{ marginTop: 0 }}>
            {mode.explain} Change the mode under <Link to="/settings?section=charger">Settings → EV charger control</Link>
            {data?.mode !== 'live' && '; Live needs the Home Assistant automation turned off first'}.
          </p>
          {data?.mode === 'live' && (
            <div className="notice" data-color="amber" role="note">
              <strong>EMHASS Lens controls the charger.</strong> Make sure the automation "EV Charging: Combined EMHASS &amp;
              Excess Solar" is off, or both will write.
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
            <div>
              <dt>Target SoC clock</dt>
              <dd>{socClockText(soc, tz)}</dd>
            </div>
            <div>
              <dt>PV reserved for the car</dt>
              <dd>
                {data?.pv_reserve ? (
                  evReserveText(data.pv_reserve, tz)
                ) : (
                  <span className="faint">off</span>
                )}
                <div className="cell-sub">
                  {data?.pv_reserve
                    ? 'While the car charges from excess solar, its share is taken out of the PV forecast EMHASS plans with.'
                    : 'Settings → EV charger control → PV reserved for Excess Solar keeps the car’s share out of the PV forecast EMHASS plans with.'}
                </div>
              </dd>
            </div>
            <AgreementFact title="Agreement, 24 h" agreement={data?.agreement_24h} />
            <AgreementFact title="Agreement, 7 days" agreement={data?.agreement_7d} />
          </dl>
        </div>
      </section>

      <div className="two-col">
        <section className="panel">
          <div className="panel-head">
            <h2>Last decision</h2>
            {last && (
              <span className="muted">
                {formatTime(last.at, new Date(), tz)} · {last.trigger.replace('_', ' ')} ·{' '}
                <Link to={`/runs/${last.run_id}`}>run {last.run_id}</Link>
              </span>
            )}
          </div>
          <div className="panel-body">
            {!last ? (
              <Empty title="No decision yet">
                {data?.mode === 'off'
                  ? 'EV charger control is off. Use Decide now to see what it would do.'
                  : 'The next decision comes with the next publish, minute check or SoC stop.'}
              </Empty>
            ) : (
              <>
                {last.blocked && (
                  <div className="notice" data-color="amber" role="note">
                    Not in control: {last.blocked}. This is what it would have done.
                  </div>
                )}
                <ChargerDecisionView decision={last.decision} inputs={last.inputs} />
                <p className="cell-sub" style={{ marginBottom: 0 }}>
                  EV power from {last.source}.
                </p>
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
                In dry run, each decision is compared a few seconds later with what the Home Assistant automation did to
                the charger.
              </Empty>
            ) : lastCompare.unexpected ? (
              <>
                <p style={{ marginTop: 0 }}>
                  <LabelledLamp color="amber" text="The automation acted on its own" />
                </p>
                <p className="cell-sub">
                  It set the current limit from {lastCompare.unexpected.from} A to {lastCompare.unexpected.to} A at{' '}
                  {formatTime(lastCompare.unexpected.at, new Date(), tz)} while EMHASS Lens had decided nothing.
                </p>
              </>
            ) : (
              <>
                <p style={{ marginTop: 0 }}>
                  <AgreeHeadline comparison={lastCompare} what="Automation vs EMHASS Lens" />
                </p>
                <CompareTable comparison={lastCompare} labels={CHARGER_FIELD_LABELS} format={chargerFieldValue} />
                {lastCompare.charging_state !== undefined && (
                  <p className="cell-sub">Charger afterwards: {chargerFieldValue('state_raw', lastCompare.charging_state)}.</p>
                )}
              </>
            )}
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Excess solar now</h2>
          {tick && <span className="muted">checked {formatTime(tick.at, new Date(), tz)}</span>}
        </div>
        <div className="panel-body">
          {!tick ? (
            <Empty title="No minute check yet" />
          ) : (
            <>
              <dl className="event-values">
                <SolarFacts derived={tick.derived} />
                <div>
                  <dt>Conclusion</dt>
                  <dd>{tick.rule === 'none' ? 'nothing to do' : tick.rule}</dd>
                  <div className="cell-sub">{tick.why}</div>
                </div>
              </dl>
            </>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-body">
          <ChargerRulesExplainer limits={limits} />
        </div>
      </section>

      <ChargerHistory timeZone={tz} />
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

/** Recent decisions: what was decided and whether the automation did the same. */
function ChargerHistory({ timeZone }: { timeZone?: string }) {
  const decides = useRuns({ job: 'charger.decide', limit: 48 })
  const compares = useRuns({ job: 'charger.compare', limit: 48 })
  const rows = pairCompares(decides.data ?? [], compares.data ?? [])
  const now = new Date()
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Recent decisions</h2>
        <span className="muted">Decisions and comparisons, newest first</span>
      </div>
      <ErrorNotice error={decides.error ?? compares.error} />
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
                <th>Decision</th>
                <th>Branch</th>
                <th>Automation</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const parsed = parseChargerSummary(row.decide?.summary)
                return (
                  <tr key={`${row.decide?.id ?? 'c'}-${row.compare?.id ?? 'd'}`}>
                    <td className="num">{formatTime(row.at, now, timeZone)}</td>
                    <td>
                      {row.decide ? (
                        <Link to={`/runs/${row.decide.id}`}>
                          <DecideChip run={row.decide} />
                        </Link>
                      ) : (
                        <span className="faint">—</span>
                      )}
                      {row.decide && !parsed && row.decide.summary && <div className="cell-sub">{row.decide.summary}</div>}
                    </td>
                    <td>
                      {parsed ? (
                        <>
                          <span className="rule-badge small word">{parsed.rule === 'none' ? '–' : parsed.rule}</span> {parsed.label}
                        </>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
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

function DecideChip({ run }: { run: RunSummary }) {
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
