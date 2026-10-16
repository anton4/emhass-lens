import { useMemo, useState, useSyncExternalStore } from 'react'
import type { ValueStore } from '../../components/charts/cursorStore'
import { slotRange } from '../../lib/chartPopup'
import type { Flows } from '../../lib/planSeries'
import { tableAround } from '../../lib/planTable'

const kw = (w: number | null) => (w === null ? '—' : (w / 1000).toFixed(2))
const pct = (v: number | null) => (v === null ? '—' : v.toFixed(1))
const eur = (v: number | null) => (v === null ? '—' : v.toFixed(3))

/** The quarter-hours around the cursor (or now, before the pointer has been on a chart) as a table: measured left of
 *  now and the plan right of it. It follows the cursor's store, so the charts don't re-render with it; it is only
 *  worked out while open. */
export function CursorTable({
  cursor,
  x,
  flows,
  soc,
  prices,
  nowS,
  timeZone,
}: {
  cursor: ValueStore<number | null>
  x: number[]
  flows: Flows
  soc: (number | null)[] | null
  prices: Map<number, { import: number | null; export: number | null }>
  nowS: number
  timeZone: string
}) {
  const [open, setOpen] = useState(false)
  const at = useSyncExternalStore(cursor.subscribe, cursor.get)
  const rows = useMemo(
    () => (open ? tableAround(at ?? nowS, x, { ...flows, soc }, prices, nowS) : []),
    [open, at, nowS, x, flows, soc, prices],
  )
  return (
    <details className="table-around" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Table view: the 6 hours around the cursor</summary>
      {open && (
        <div className="table-wrap sticky-table">
          <table className="num-table">
            <thead>
              <tr>
                <th>Slot</th>
                <th className="r">Grid kW</th>
                <th className="r">PV kW</th>
                <th className="r">House kW</th>
                <th className="r" title="+ charging">
                  Battery kW
                </th>
                <th className="r">SOC %</th>
                <th className="r">Import €/kWh</th>
                <th className="r">Export €/kWh</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.t} data-current={r.current || undefined} data-plan={!r.measured || undefined}>
                  <td className="num">{slotRange(r.t, r.t + 900, timeZone)}</td>
                  <td className="num r">{kw(r.grid)}</td>
                  <td className="num r">{kw(r.pv)}</td>
                  <td className="num r">{kw(r.house)}</td>
                  <td className="num r">{kw(r.battery)}</td>
                  <td className="num r">{pct(r.soc)}</td>
                  <td className="num r">{eur(r.import)}</td>
                  <td className="num r">{eur(r.export)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  )
}
