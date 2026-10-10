import { Link } from 'react-router'
import type { PlanHistoryResponse, QuantityAccuracy } from '../../api/types'
import { Empty } from '../../components/PageHead'
import { HORIZONS } from '../../lib/planHistory'
import { formatPower } from '../../lib/units'

const ROWS: { key: string; label: string }[] = [
  { key: 'load', label: 'House load' },
  { key: 'pv', label: 'PV' },
  { key: 'soc', label: 'Battery SOC' },
  { key: 'grid', label: 'Grid power' },
  { key: 'batt', label: 'Battery power' },
]

function fmt(q: QuantityAccuracy | undefined, field: 'mae' | 'bias'): string {
  const v = q?.[field]
  if (v === null || v === undefined) return '—'
  const sign = field === 'bias' && v > 0 ? '+' : ''
  if (q?.unit === '%') return `${sign}${v.toFixed(1)} pp`
  return `${sign}${formatPower(v)}`
}

function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${v.toFixed(0)} %`
}

/** The price forecast's error, which the API gives in c/kWh, as €/kWh like the rest of the Plan page. */
function eurFromCents(v: number | null | undefined, signed = false): string {
  if (v === null || v === undefined) return '—'
  return `${signed && v > 0 ? '+' : ''}${(v / 100).toFixed(4)} €/kWh`
}

/** How far the plan has been from what happened: MAE and bias per quantity over 24 h and 7 d. */
export function AccuracyCard({ history }: { history: PlanHistoryResponse | undefined }) {
  if (!history) return <Empty title="Loading…" />
  const configured = history.measurements.configured
  if (configured.length === 0) {
    return (
      <Empty title="No measurement entities set">
        Choose the sensors for grid, battery, PV, house load and SOC under{' '}
        <Link to="/settings?section=measurements">Settings → Measurements</Link>, and the Plan page shows what actually
        happened next to the plan.
      </Empty>
    )
  }
  const [day, week] = history.accuracy
  const byKey = (w: typeof day | undefined) => new Map((w?.quantities ?? []).map((q) => [q.quantity, q]))
  const d = byKey(day)
  const w = byKey(week)
  const have = new Set(configured.map((c) => c.quantity))
  const horizon = HORIZONS.find((h) => h.slots === history.horizon)?.label ?? `${history.horizon} slots ahead`
  const suspects = ROWS.filter((r) => d.get(r.key)?.sign_suspect || w.get(r.key)?.sign_suspect)
  const remaining = history.measurements.backfill_remaining_slots
  const pf = history.price_forecast
  return (
    <>
      <div className="table-wrap">
        <table className="num-table accuracy-table">
          <thead>
            <tr>
              <th>Quantity</th>
              <th className="r">24 h error</th>
              <th className="r">24 h bias</th>
              <th className="r">7 d error</th>
              <th className="r">7 d bias</th>
              <th className="r">Slots (7 d)</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.filter((r) => have.has(r.key)).map((r) => (
              <tr key={r.key}>
                <td>{r.label}</td>
                <td className="num r">{fmt(d.get(r.key), 'mae')}</td>
                <td className="num r">{fmt(d.get(r.key), 'bias')}</td>
                <td className="num r">{fmt(w.get(r.key), 'mae')}</td>
                <td className="num r">{fmt(w.get(r.key), 'bias')}</td>
                <td className="num r">{w.get(r.key)?.n ?? 0}</td>
              </tr>
            ))}
            {pf && (
              <tr>
                <td>
                  Price forecast
                  <div className="cell-sub">
                    {pf.provider}, {pf.lead_hours} h ahead, vs Nord Pool
                  </div>
                </td>
                <td className="num r" colSpan={2}>
                  —
                </td>
                <td className="num r">
                  {eurFromCents(pf.mae)}
                  {pf.mape !== null && pf.mape !== undefined && <div className="cell-sub">{pct(pf.mape)} MAPE</div>}
                </td>
                <td className="num r">{eurFromCents(pf.bias, true)}</td>
                <td className="num r">{pf.n}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="accuracy-hint">
        Error is the mean absolute difference between the plan and the measurement per quarter-hour; bias is the mean
        signed difference (plus: the plan expected more). Planned values are taken from the plan <em>{horizon}</em>
        {history.horizon === 0 ? ' when the slot came' : ' of each slot'}
        {d.get('load')?.mape !== null && d.get('load')?.mape !== undefined
          ? `; the load error is ${pct(d.get('load')?.mape)} of the measured load over 24 h.`
          : '.'}
      </p>
      {remaining > 0 && (
        <p className="accuracy-hint">
          Still reading history from Home Assistant: {remaining} quarter-hours to go. The numbers fill in as it lands.
        </p>
      )}
      {suspects.length > 0 && (
        <p className="accuracy-hint">
          {suspects.map((s) => s.label).join(' and ')} move against the plan most of the time, which usually means the
          sensor counts the other way round: tick “Opposite sign” under{' '}
          <Link to="/settings?section=measurements">Settings → Measurements</Link>.
        </p>
      )}
      {history.measurements.last_error && (
        <p className="accuracy-hint">Last recorder read failed: {history.measurements.last_error}</p>
      )}
    </>
  )
}
