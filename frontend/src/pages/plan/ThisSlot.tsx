import type { PlanRow } from '../../api/types'
import { deferrableColumns, num, socOf } from '../../lib/plan'
import { batteryDirection, formatFraction, formatPower, formatPrice, gridDirection } from '../../lib/units'

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="cell-sub">{sub}</div>}
    </div>
  )
}

/** What EMHASS wants right now: the plan row of the current quarter-hour. */
export function ThisSlot({ row, columns }: { row: PlanRow; columns: string[] }) {
  const batt = num(row, 'P_batt')
  const grid = num(row, 'P_grid')
  const curtail = num(row, 'P_PV_curtailment')
  const deferrables = deferrableColumns(columns)
  const loadCost = num(row, 'unit_load_cost')
  const prodPrice = num(row, 'unit_prod_price')
  return (
    <div className="tiles">
      {batt !== null && <Tile label="Battery" value={formatPower(Math.abs(batt))} sub={batteryDirection(batt)} />}
      {grid !== null && <Tile label="Grid" value={formatPower(Math.abs(grid))} sub={gridDirection(grid)} />}
      {num(row, 'P_PV') !== null && (
        <Tile
          label="PV"
          value={formatPower(num(row, 'P_PV'))}
          sub={curtail !== null && curtail > 0 ? `${formatPower(curtail)} curtailed` : 'No curtailment'}
        />
      )}
      {num(row, 'P_Load') !== null && <Tile label="House load" value={formatPower(num(row, 'P_Load'))} sub="forecast" />}
      {deferrables.map((c, i) => (
        <Tile
          key={c}
          label={deferrables.length === 1 ? 'Deferrable load' : `Deferrable load ${i + 1}`}
          value={formatPower(num(row, c))}
          sub={(num(row, c) ?? 0) > 0 ? 'Running' : 'Off'}
        />
      ))}
      {socOf(row) !== null && <Tile label="SOC at slot end" value={formatFraction(socOf(row))} sub="planned" />}
      {loadCost !== null && (
        <Tile
          label="Import price"
          value={formatPrice(loadCost)}
          sub={prodPrice !== null ? `export ${formatPrice(prodPrice)}` : undefined}
        />
      )}
    </div>
  )
}
