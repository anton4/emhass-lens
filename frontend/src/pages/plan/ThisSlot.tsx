import type { PlanRow } from '../../api/types'
import { Lamp } from '../../components/Lamp'
import { deferrableColumns, num, socOf } from '../../lib/plan'
import { measuredText, measuredTitle, type NowByKey } from '../../lib/planNow'
import { batteryDirection, formatCents, formatFraction, formatPower, gridDirection } from '../../lib/units'

function Tile({
  label,
  value,
  sub,
  now,
  differs,
  nowTitle,
  quantity,
}: {
  label: string
  value: string
  sub?: string
  now?: string | null
  differs?: boolean | null
  nowTitle?: string
  /** The quantity's chart colour ("--q-batt"), shown as a swatch next to the label. */
  quantity?: string
}) {
  return (
    <div className="tile" data-differs={differs || undefined}>
      <div className="tile-label">
        <span className="tile-name">
          {quantity && <span className="swatch" style={{ background: `var(${quantity})` }} aria-hidden="true" />}
          {label}
        </span>
        {differs === true && <Lamp color="amber" label="differs from the plan" />}
        {differs === false && <Lamp color="green" label="as planned" />}
      </div>
      <div className="tile-value">{value}</div>
      {sub && <div className="cell-sub">{sub}</div>}
      {now && (
        <div className="tile-now" title={nowTitle}>
          {now}
        </div>
      )}
    </div>
  )
}

/** A plan row as tiles; with `now`, each tile also shows what is measured and whether that differs. */
export function ThisSlot({
  row,
  columns,
  now,
  charger,
}: {
  row: PlanRow
  columns: string[]
  now?: NowByKey
  charger?: string | null
}) {
  const batt = num(row, 'P_batt')
  const grid = num(row, 'P_grid')
  const curtail = num(row, 'P_PV_curtailment')
  const deferrables = deferrableColumns(columns)
  const loadCost = num(row, 'unit_load_cost')
  const prodPrice = num(row, 'unit_prod_price')
  const m = (key: keyof NowByKey) => ({
    now: measuredText(now?.[key]),
    differs: now?.[key]?.differs,
    nowTitle: measuredTitle(now?.[key]),
  })
  return (
    <div className="tiles">
      {batt !== null && (
        <Tile
          label="Battery"
          quantity="--q-batt"
          value={formatPower(Math.abs(batt))}
          sub={batteryDirection(batt)}
          {...m('batt')}
        />
      )}
      {grid !== null && (
        <Tile
          label="Grid"
          quantity="--q-grid"
          value={formatPower(Math.abs(grid))}
          sub={gridDirection(grid)}
          {...m('grid')}
        />
      )}
      {num(row, 'P_PV') !== null && (
        <Tile
          label="PV"
          quantity="--q-pv"
          value={formatPower(num(row, 'P_PV'))}
          sub={curtail !== null && curtail > 0 ? `${formatPower(curtail)} curtailed` : 'No curtailment'}
          {...m('pv')}
        />
      )}
      {num(row, 'P_Load') !== null && (
        <Tile
          label="House load"
          quantity="--q-load"
          value={formatPower(num(row, 'P_Load'))}
          sub="forecast"
          {...m('load')}
        />
      )}
      {deferrables.map((c, i) => (
        <Tile
          key={c}
          label={deferrables.length === 1 ? 'Deferrable load' : `Deferrable load ${i + 1}`}
          quantity="--q-ev"
          value={formatPower(num(row, c))}
          sub={(num(row, c) ?? 0) > 0 ? 'Running' : 'Off'}
          now={i === 0 ? charger : null}
        />
      ))}
      {socOf(row) !== null && (
        <Tile
          label="SOC at slot end"
          quantity="--q-batt"
          value={formatFraction(socOf(row), 0)}
          sub="planned"
          {...m('soc')}
        />
      )}
      {loadCost !== null && (
        <Tile
          label="Import price"
          quantity="--q-import"
          value={formatCents(loadCost)}
          sub={prodPrice !== null ? `export ${formatCents(prodPrice)}` : undefined}
        />
      )}
    </div>
  )
}
