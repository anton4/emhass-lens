import type { ChargerSettings } from '../api/types'
import {
  chargerFormulas,
  chargerRules,
  chargerStateText,
  type ChargerDecision,
  type ChargerDerived,
  type ChargerInputs,
  type ChargerObserved,
} from '../lib/charger'
import { kwText } from '../lib/publish'

/** A charger decision: which branch matched and why, what it sets, and what it was decided from. */
export function ChargerDecisionView({
  decision,
  inputs,
  observedBefore,
}: {
  decision: ChargerDecision
  inputs?: ChargerInputs
  observedBefore?: ChargerObserved
}) {
  const d = decision.derived
  return (
    <>
      <div className="decision-head">
        <span className="rule-badge word" aria-label={`Rule ${decision.rule}`}>
          {decision.rule === 'none' ? '–' : decision.rule}
        </span>
        <div>
          <div className="cell-title">{decision.label}</div>
          <div className="cell-sub">{decision.why}</div>
        </div>
      </div>
      {decision.action !== 'none' && (
        <dl className="facts">
          <div>
            <dt>Does</dt>
            <dd>{actionText(decision)}</dd>
          </div>
          {decision.target_current_a !== null && (
            <div>
              <dt>Current limit</dt>
              <dd>
                {decision.target_current_a} A
                {observedBefore && observedBefore.current_limit_a !== null && (
                  <div className="cell-sub">before: {Math.round(observedBefore.current_limit_a)} A</div>
                )}
              </dd>
            </div>
          )}
          {decision.notify && (
            <div>
              <dt>Phone message</dt>
              <dd>“{decision.notify}”</dd>
            </div>
          )}
        </dl>
      )}
      {inputs && (
        <>
          <h3 className="sub-head">Decided from</h3>
          <dl className="event-values">
            <div>
              <dt>Charge mode</dt>
              <dd>{inputs.charge_mode ?? '—'}</dd>
            </div>
            <div>
              <dt>Charger</dt>
              <dd>{chargerStateText(inputs.state_raw)}</dd>
              <div className="cell-sub">limit {Math.round(inputs.current_limit_a)} A, max {inputs.solar_limit_a} A</div>
            </div>
            <div>
              <dt>Car</dt>
              <dd>{Math.round(inputs.soc)} %</dd>
              <div className="cell-sub">target {inputs.target_soc === null ? '—' : `${Math.round(inputs.target_soc)} %`}</div>
            </div>
            <div>
              <dt>Plan EV power</dt>
              <dd>{inputs.p_deferrable0_w === null ? '—' : kwText(inputs.p_deferrable0_w)}</dd>
              {d.emhass_current_a !== null && <div className="cell-sub">= {d.emhass_current_a} A</div>}
            </div>
            <SolarFacts derived={d} />
          </dl>
        </>
      )}
    </>
  )
}

function actionText(decision: ChargerDecision): string {
  switch (decision.action) {
    case 'stop_soc':
      return 'press stop, current limit 0 A, target SoC back to 100 %'
    case 'start':
      return `press start, current limit ${decision.target_current_a} A`
    case 'set_current':
      return `current limit ${decision.target_current_a} A`
    case 'pause':
      return 'current limit 0 A'
    default:
      return 'nothing'
  }
}

/** The excess-solar arithmetic: PV, other load, the charger's own draw and the resulting current. */
export function SolarFacts({ derived }: { derived: ChargerDerived }) {
  return (
    <>
      <div>
        <dt>PV</dt>
        <dd>{kwText(derived.pv_power_w)}</dd>
        <div className="cell-sub">
          {derived.pv_source}, {derived.pv_age_s >= 9999 ? 'no timestamp' : `${Math.round(derived.pv_age_s)} s old`}
        </div>
      </div>
      <div>
        <dt>Other load</dt>
        <dd>{kwText(derived.other_load_w)}</dd>
        <div className="cell-sub">charger's own draw {kwText(derived.charger_commanded_w)}</div>
      </div>
      <div>
        <dt>Solar current</dt>
        <dd>{derived.solar_target_a} A</dd>
      </div>
    </>
  )
}

/** The branches in plain words, in the automation's order, with the configured limits. */
/** The branches in the automation's order; the one of the last decision is tagged, and the details fold away. */
export function ChargerRulesExplainer({
  limits,
  current,
}: {
  limits: ChargerSettings['limits'] | undefined
  /** The branch of the last decision. */
  current?: string | null
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>How a branch is chosen</h2>
        <span className="muted">The first match wins, top to bottom</span>
      </div>
      <div className="panel-body">
        <ol className="rule-steps">
          {chargerRules(limits).map((r) => (
            <li key={r.id}>
              <div className="cell-title">
                <span className="rule-badge small word">{r.id}</span> {r.label}
                {r.id === current && (
                  <span className="chip" data-color="blue">
                    chosen last
                  </span>
                )}
              </div>
              <div>
                <span className="muted">When</span> {r.when}
              </div>
              <div>
                <span className="muted">Does</span> {r.sets}
              </div>
            </li>
          ))}
        </ol>
        <details className="more rules-more">
          <summary>More about decisions</summary>
          <p>
            The first branch that matches is taken, exactly like the Home Assistant automation "EV Charging: Combined
            EMHASS &amp; Excess Solar". Your charge-mode helper picks EMHASS mode (follow the plan's EV power) or Excess
            Solar mode (follow the PV surplus); Manual means EMHASS Lens does nothing. The target-SoC stop comes first
            in any mode.
          </p>
          <h3 className="sub-head">The arithmetic</h3>
          <ul>
            {chargerFormulas(limits).map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
          <h3 className="sub-head">When it decides</h3>
          <ul>
            <li>Right after each publish (and whenever EMHASS's EV power sensor changes): EMHASS mode.</li>
            <li>
              Every minute: Excess Solar mode, the target-SoC clock, and EMHASS mode when the charger's state changed.
            </li>
            <li>When the car's SoC has held at the target long enough: the stop.</li>
          </ul>
          <h3 className="sub-head">Modes</h3>
          <ul>
            <li>
              <strong>Off</strong>: nothing is scheduled; "Decide now" still shows what it would do.
            </li>
            <li>
              <strong>Dry run</strong>: each decision is recorded with the calls it would make, and a few seconds later
              the charger is read to see whether the automation did the same. The charger is never touched.
            </li>
            <li>
              <strong>Live</strong>: EMHASS Lens presses start/stop, sets the current limit and the target SoC, sends
              the phone message, and reads the charger back. It refuses to act while the automation set as the interlock
              is on, without a Home Assistant connection, or above the maximum current.
            </li>
          </ul>
        </details>
      </div>
    </section>
  )
}
