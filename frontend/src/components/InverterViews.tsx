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

/** Decided vs observed, field by field (comparison with the automation, or the readback after applying). */
export function CompareTable({ comparison, observedLabel = 'Automation set' }: { comparison: InverterComparison; observedLabel?: string }) {
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
              <td>{FIELD_LABELS[f.field] ?? f.field}</td>
              <td className={f.field === 'state' ? undefined : 'num'}>{fieldValue(f.field, f.decided)}</td>
              <td className={f.field === 'state' ? undefined : 'num'}>{fieldValue(f.field, f.observed)}</td>
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

/** The Home Assistant service calls a live decision made. */
export function CallsList({ calls }: { calls: InverterCall[] }) {
  if (calls.length === 0) return <p className="cell-sub">No calls: the inverter already showed the targets.</p>
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
              <td>{c.option ?? (c.value !== undefined ? String(c.value) : '—')}</td>
              <td>
                {c.ok ? <LabelledLamp color="green" text="OK" /> : <LabelledLamp color="red" text={c.error ?? 'failed'} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The rules in plain words, in the automation's order, with the configured thresholds. */
export function RulesExplainer({ limits }: { limits: InverterSettings['limits'] | undefined }) {
  return (
    <details className="explain-details rules-explainer">
      <summary>
        <h3 className="sub-head" style={{ display: 'inline' }}>
          How decisions are made
        </h3>
      </summary>
      <p>
        Each slot, the plan's values pick one of these modes: <strong>P_grid</strong> picks the branch (importing above
        100 W, exporting below −100 W, otherwise neutral), <strong>P_batt</strong> picks the mode (charging below −100 W,
        discharging above 100 W, otherwise idle), and when exporting with an idle battery the export price breaks the tie.
        They are the same rules and thresholds as the Home Assistant automation "EMHASS: Consolidated Inverter Control", so
        dry-run decisions can be compared with it slot by slot. Signs follow EMHASS: P_batt + discharges / − charges the
        battery; P_grid + imports / − exports.
      </p>
      <ol className="rules-list">
        {rules(limits).map((r, i) => (
          <li key={`${r.id}-${i}`}>
            <div className="cell-title">
              <span className="rule-badge small word">{r.id}</span> {r.label}
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
      <p className="cell-sub">Every combination of grid and battery power matches one of these, so a decision is made every slot.</p>
      <h3 className="sub-head">Feed-in limit</h3>
      <ul>
        {feedinRules(limits).map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
      <h3 className="sub-head">Modes</h3>
      <ul>
        <li>
          <strong>Off</strong>: nothing is decided.
        </li>
        <li>
          <strong>Dry run</strong>: at mm:00:05 of each slot (right after the plan is published) the decision is recorded; at
          mm:00:45 the inverter entities are read and compared with it, which shows whether the automation did the same.
          The inverter is never touched.
        </li>
        <li>
          <strong>Live</strong>: EMHASS Lens applies the decision itself: the passive-state select, the three passive-mode
          numbers and their apply button, the feed-in limit and its button, then reads them back. Turn the Home Assistant
          automation off first, or both will write. It refuses to act with a stale plan or targets outside the configured
          limits.
        </li>
      </ul>
      <p className="cell-sub">
        Nothing is decided while the inverter isn't in passive mode or the automation switch (input_boolean.emhass_automation)
        is off, for example during an mFRR session.
      </p>
    </details>
  )
}
