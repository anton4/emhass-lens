import type { InverterSettings } from '../api/types'
import {
  FIELD_LABELS,
  feedinRules,
  fieldValue,
  rules,
  type InverterCall,
  type InverterComparison,
  type InverterDecision,
  type ObservedValues,
  type PlanValues,
} from '../lib/inverter'
import { batteryText, gridText, kwText } from '../lib/publish'
import { LabelledLamp } from './Lamp'

/** A decision: which rule matched and why, and the targets it sets (or would set). */
export function DecisionView({
  decision,
  values,
  observedBefore,
}: {
  decision: InverterDecision
  values?: PlanValues
  observedBefore?: ObservedValues
}) {
  const t = decision.targets
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
      <div className="table-wrap">
        <table className="decision-table">
          <thead>
            <tr>
              <th>Setting</th>
              <th>Target</th>
              {observedBefore && <th>Before</th>}
            </tr>
          </thead>
          <tbody>
            {t ? (
              <>
                <TargetRow field="state" target={t.state} before={observedBefore?.state} showBefore={!!observedBefore} />
                <TargetRow
                  field="grid_power_w"
                  target={t.grid_power_w}
                  before={observedBefore?.grid_power_w}
                  showBefore={!!observedBefore}
                />
                <TargetRow
                  field="battery_min_w"
                  target={t.battery_min_w}
                  before={observedBefore?.battery_min_w}
                  showBefore={!!observedBefore}
                />
                <TargetRow
                  field="battery_max_w"
                  target={t.battery_max_w}
                  before={observedBefore?.battery_max_w}
                  showBefore={!!observedBefore}
                />
              </>
            ) : (
              <tr>
                <td>Passive mode</td>
                <td className="cell-sub" colSpan={observedBefore ? 2 : 1}>
                  No change (no rule matches)
                </td>
              </tr>
            )}
            <tr>
              <td>
                {FIELD_LABELS.feedin_max_w}
                <div className="cell-sub">{decision.feedin_why}</div>
              </td>
              <td className="num">{fieldValue('feedin_max_w', decision.feedin_max_w)}</td>
              {observedBefore && <td className="num">{fieldValue('feedin_max_w', observedBefore.feedin_max_w)}</td>}
            </tr>
          </tbody>
        </table>
      </div>
      {values && (
        <>
          <h3 className="sub-head">Plan values used</h3>
          <dl className="event-values">
            <div>
              <dt>Battery</dt>
              <dd>{batteryText(values.p_batt)}</dd>
              <div className="cell-sub">P_batt {Math.round(values.p_batt)} W (+ discharge, − charge)</div>
            </div>
            <div>
              <dt>Grid</dt>
              <dd>{gridText(values.p_grid)}</dd>
              <div className="cell-sub">P_grid {Math.round(values.p_grid)} W (+ import, − export)</div>
            </div>
            <div>
              <dt>PV</dt>
              <dd>{kwText(values.p_pv)}</dd>
              {values.p_pv_curtailment ? <div className="cell-sub">curtailed {kwText(values.p_pv_curtailment)}</div> : null}
            </div>
            <div>
              <dt>Export price</dt>
              <dd>{values.export_price === null ? '—' : `${(values.export_price * 100).toFixed(2)} c`}</dd>
              <div className="cell-sub">c/kWh for this slot</div>
            </div>
          </dl>
        </>
      )}
    </>
  )
}

function TargetRow({
  field,
  target,
  before,
  showBefore,
}: {
  field: string
  target: string | number
  before: string | number | null | undefined
  showBefore: boolean
}) {
  return (
    <tr>
      <td>{FIELD_LABELS[field] ?? field}</td>
      <td className={typeof target === 'number' ? 'num' : undefined}>{fieldValue(field, target)}</td>
      {showBefore && <td className={typeof target === 'number' ? 'num' : undefined}>{fieldValue(field, before)}</td>}
    </tr>
  )
}

/** Decided vs observed, field by field (comparison with the automation, or the readback after applying).
 * `labels` and `format` default to the inverter's fields; the charger passes its own. */
export function CompareTable({
  comparison,
  observedLabel = 'Automation set',
  labels = FIELD_LABELS,
  format = fieldValue,
}: {
  comparison: InverterComparison
  observedLabel?: string
  labels?: Record<string, string>
  format?: (field: string, value: string | number | null | undefined) => string
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Setting</th>
            <th>Decided</th>
            <th>{observedLabel}</th>
            <th>Same</th>
          </tr>
        </thead>
        <tbody>
          {comparison.fields.map((f) => (
            <tr key={f.field}>
              <td>{labels[f.field] ?? f.field}</td>
              <td className={typeof f.decided === 'string' ? undefined : 'num'}>{format(f.field, f.decided)}</td>
              <td className={typeof f.decided === 'string' ? undefined : 'num'}>{format(f.field, f.observed)}</td>
              <td>
                <LabelledLamp color={f.same ? 'green' : 'amber'} text={f.same ? '✓ Same' : '✗ Differs'} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function AgreeHeadline({ comparison, what }: { comparison: InverterComparison; what: string }) {
  return comparison.agree ? (
    <LabelledLamp color="green" text={`${what}: the same`} />
  ) : (
    <LabelledLamp color="amber" text={`${what}: differs`} />
  )
}

/** The Home Assistant service calls a decision made (or, in dry run, would have made). */
export function CallsList({ calls, nothing = 'No calls: the inverter already showed the targets.' }: { calls: InverterCall[]; nothing?: string }) {
  if (calls.length === 0) return <p className="cell-sub">{nothing}</p>
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Service</th>
            <th>Entity</th>
            <th>Value</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c, i) => (
            <tr key={i}>
              <td>
                <code>{c.service}</code>
              </td>
              <td className="wrap">
                <code>{c.entity_id ?? '—'}</code>
              </td>
              <td className="wrap">{c.message ? `“${c.message}”` : (c.option ?? (c.value !== undefined ? String(c.value) : '—'))}</td>
              <td>
                {c.ok ? (
                  <LabelledLamp color="green" text="OK" />
                ) : c.ok === null ? (
                  <span className="cell-sub">{c.dry_run ? 'not sent (dry run)' : (c.skipped ?? 'not sent')}</span>
                ) : (
                  <LabelledLamp color="red" text={c.error ?? 'failed'} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The rules in plain words, in the automation's order, with the configured thresholds; the one chosen for this
 *  slot is tagged, and the details fold away. */
export function RulesExplainer({
  limits,
  noExportAtOrBelow,
  current,
}: {
  limits: InverterSettings['limits'] | undefined
  /** Settings → EMHASS → MPC "No export at or below"; null when empty. */
  noExportAtOrBelow: number | null
  /** The rule of this slot's decision. */
  current?: string | null
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>How a rule is chosen</h2>
        <span className="muted">The first match wins, top to bottom</span>
      </div>
      <div className="panel-body">
        <ol className="rule-steps">
          {rules(limits, noExportAtOrBelow).map((r, i) => (
            <li key={`${r.id}-${i}`}>
              <div className="cell-title">
                <span className="rule-badge small word">{r.id}</span> {r.label}
                {r.id === current && (
                  <span className="chip" data-color="blue">
                    chosen now
                  </span>
                )}
              </div>
              <div>
                <span className="muted">When</span> {r.when}
              </div>
              <div>
                <span className="muted">Sets</span> {r.sets}
              </div>
            </li>
          ))}
        </ol>
        <details className="more rules-more">
          <summary>More about decisions</summary>
          <p>
            Each slot, the plan's values pick one of these modes: <strong>P_grid</strong> picks the branch (importing
            above 100 W, exporting below −100 W, otherwise neutral), <strong>P_batt</strong> picks the mode (charging
            below −100 W, discharging above 100 W, otherwise idle), and when exporting with an idle battery the export
            price breaks the tie. They are the same rules and thresholds as the Home Assistant automation "EMHASS:
            Consolidated Inverter Control", so dry-run decisions can be compared with it slot by slot. The export price
            threshold is Settings → EMHASS → MPC "No export at or below", which also keeps EMHASS from planning exports
            in those slots. Signs follow EMHASS: P_batt + discharges / − charges the battery; P_grid + imports / −
            exports.
          </p>
          <p className="cell-sub">
            Every combination of grid and battery power matches one of these, so a decision is made every slot.
          </p>
          <h3 className="sub-head">Feed-in limit</h3>
          <ul>
            {feedinRules(limits, noExportAtOrBelow).map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
          <h3 className="sub-head">Modes</h3>
          <ul>
            <li>
              <strong>Off</strong>: nothing is decided.
            </li>
            <li>
              <strong>Dry run</strong>: at mm:00:05 of each slot (right after the plan is published) the decision is
              recorded; at mm:00:45 the inverter entities are read and compared with it, which shows whether the
              automation did the same. The inverter is never touched.
            </li>
            <li>
              <strong>Live</strong>: EMHASS Lens applies the decision itself: the passive-state select, the three
              passive-mode numbers and their apply button, the feed-in limit and its button, then reads them back. Turn
              the Home Assistant automation off first, or both will write. It refuses to act with a stale plan or
              targets outside the configured limits.
            </li>
          </ul>
          <p className="cell-sub">
            Nothing is decided while the inverter isn't in passive mode or the automation switch
            (input_boolean.emhass_automation) is off, for example during an mFRR session.
          </p>
        </details>
      </div>
    </section>
  )
}
