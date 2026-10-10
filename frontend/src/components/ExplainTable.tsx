import { useState } from 'react'
import type { Derived, EvReserve, ExplainSlot } from '../api/types'
import { evReserveText } from '../lib/evReserve'
import { formatSlot, formatTime } from '../lib/format'
import { originLabel, periodLabel } from '../lib/prices'
import { formatPower } from '../lib/units'

/** Derived run parameters with the formula that produced them. */
export function DerivedFacts({ derived, anchor, rounding }: { derived: Derived; anchor?: string | null; rounding?: string }) {
  return (
    <dl className="facts">
      {anchor && (
        <div>
          <dt>First slot (anchor)</dt>
          <dd>{formatTime(anchor)}</dd>
        </div>
      )}
      {rounding && (
        <div>
          <dt>EMHASS start rounding</dt>
          <dd>{rounding}</dd>
        </div>
      )}
      <div>
        <dt>num_lags</dt>
        <dd>
          {derived.num_lags} <span className="cell-sub">({derived.num_lags_formula})</span>
        </dd>
      </div>
      <div>
        <dt>History days</dt>
        <dd>{derived.historic_days_to_retrieve}</dd>
      </div>
      <div>
        <dt>delta_forecast_daily</dt>
        <dd>{derived.delta_forecast_daily}</dd>
      </div>
      <div>
        <dt>Forecast days</dt>
        <dd>{derived.extend_days}</dd>
      </div>
    </dl>
  )
}

/** What the PV reservation for the EV did to this payload, when the feature is on. */
export function EvReserveNote({ reserve, tz }: { reserve: EvReserve | null | undefined; tz?: string }) {
  const text = evReserveText(reserve, tz)
  if (!text) return null
  return (
    <p className="chart-note" data-testid="ev-reserve-note">
      <strong>PV reserved for the EV.</strong> {text}
    </p>
  )
}

const PAGE = 96

/** The positional payload next to the slot each position stands for. */
export function ExplainTable({ slots }: { slots: ExplainSlot[] }) {
  const [shown, setShown] = useState(PAGE)
  const withP10 = slots.some((s) => s.pv_p10_w !== null && s.pv_p10_w !== undefined)
  const withReserve = slots.some((s) => (s.ev_reserved_w ?? 0) > 0)
  return (
    <>
      <div className="table-wrap sticky-table">
        <table className="num-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Slot</th>
              <th>Source</th>
              <th>Period</th>
              <th className="r">Spot €/kWh</th>
              <th className="r">load_cost</th>
              <th className="r">prod_price</th>
              <th className="r">PV</th>
              {withP10 && <th className="r">PV P10</th>}
              {withReserve && (
                <th className="r" title="Taken out of the PV forecast because the car charges it from excess solar">
                  EV reserve
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {slots.slice(0, shown).map((s) => (
              <tr key={s.i} data-forecast={s.origin !== 'actual' || undefined}>
                <td className="num">{s.i}</td>
                <td className="num">
                  <time dateTime={s.start}>{formatSlot(s.start)}</time>
                </td>
                <td className="cell-sub">{originLabel(s.origin)}</td>
                <td>{periodLabel(s.period)}</td>
                <td className="num r">{s.spot.toFixed(5)}</td>
                <td className="num r">{s.load_cost.toFixed(4)}</td>
                <td className="num r">{s.prod_price.toFixed(4)}</td>
                <td className="num r">{formatPower(s.pv_w)}</td>
                {withP10 && <td className="num r">{s.pv_p10_w === null || s.pv_p10_w === undefined ? '—' : formatPower(s.pv_p10_w)}</td>}
                {withReserve && <td className="num r">{(s.ev_reserved_w ?? 0) > 0 ? formatPower(s.ev_reserved_w) : '—'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {slots.length > shown && (
        <button type="button" className="quiet" onClick={() => setShown((n) => n + PAGE * 2)}>
          {slots.length - shown <= PAGE * 2
            ? `Show the other ${slots.length - shown}`
            : `Show ${PAGE * 2} more (${slots.length - shown} not shown)`}
        </button>
      )}
    </>
  )
}
