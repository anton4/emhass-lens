import type { PriceSlot } from '../../api/types'
import { localTime, originLabel, periodLabel } from '../../lib/prices'
import { priceFactor, type PriceUnit } from '../../lib/units'

const COLUMNS: { key: keyof PriceSlot; label: string }[] = [
  { key: 'spot', label: 'Spot' },
  { key: 'margin', label: 'Margin' },
  { key: 'renewable', label: 'Renewable' },
  { key: 'excise', label: 'Excise' },
  { key: 'balancing', label: 'Balancing' },
  { key: 'supply_security', label: 'Supply sec.' },
  { key: 'network', label: 'Network' },
  { key: 'vat', label: 'VAT' },
  { key: 'import_price', label: 'Import' },
  { key: 'export_price', label: 'Export' },
]

/** Every quarter-hour of one day with every price component. */
export function Breakdown({ slots, unit, timeZone, nowS }: { slots: PriceSlot[]; unit: PriceUnit; timeZone: string; nowS: number }) {
  const f = priceFactor(unit)
  const digits = unit === 'cents' ? 3 : 5
  return (
    <div className="table-wrap sticky-table">
      <table className="num-table breakdown">
        <thead>
          <tr>
            <th>Time</th>
            <th>Rate</th>
            {COLUMNS.map((c) => (
              <th key={c.key} className="r">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {slots.map((s) => {
            const current = Date.parse(s.start) / 1000 <= nowS && nowS < Date.parse(s.end) / 1000
            return (
              <tr key={s.start} data-current={current || undefined} data-forecast={s.origin !== 'actual' || undefined}>
                <td className="num">
                  <time dateTime={s.start}>{localTime(s.start, timeZone)}</time>
                  {s.origin !== 'actual' && <div className="cell-sub">{originLabel(s.origin)}</div>}
                </td>
                <td>
                  {periodLabel(s.period)}
                  <div className="cell-sub">{s.reason}</div>
                </td>
                {COLUMNS.map((c) => (
                  <td key={c.key} className={`num r${c.key === 'import_price' || c.key === 'export_price' ? ' strong' : ''}`}>
                    {((s[c.key] as number) * f).toFixed(digits)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
