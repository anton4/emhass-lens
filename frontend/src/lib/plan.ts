// EMHASS plan rows (GET /api/plan): one object per 15-minute slot, columns vary with the EMHASS
// configuration (see EMHASS docs/plan_output_schema.md). Signs: P_batt > 0 discharge, P_grid > 0 import.

import type { PlanRow } from '../api/types'
import { formatTime } from './format'
import { isNumber } from './units'

export const SLOT_S = 900

export function rowTime(row: PlanRow): number | null {
  const ts = row.timestamp
  if (typeof ts !== 'string') return null
  const ms = Date.parse(ts)
  return Number.isNaN(ms) ? null : ms / 1000
}

/** The row whose slot contains `nowS` (unix seconds), if any. */
export function rowAt(rows: PlanRow[], nowS: number): PlanRow | null {
  for (const row of rows) {
    const t = rowTime(row)
    if (t !== null && t <= nowS && nowS < t + SLOT_S) return row
  }
  return null
}

/** Numeric value of a column, or null. */
export function num(row: PlanRow | null | undefined, column: string): number | null {
  const v = row?.[column]
  return isNumber(v) ? v : null
}

/** Deferrable-load power columns present in the plan, in order (P_deferrable0, P_deferrable1, …). */
export function deferrableColumns(columns: string[]): string[] {
  return columns.filter((c) => /^P_deferrable\d+$/.test(c)).sort((a, b) => Number(a.slice(12)) - Number(b.slice(12)))
}

export function hasColumn(rows: PlanRow[], column: string): boolean {
  return rows.some((r) => isNumber(r[column]))
}

/** The planned-SOC columns: `SOC_opt` for one battery, `SOC_opt_0`, `SOC_opt_1`, … with EMHASS 0.18's
 *  number_of_batteries > 1 (which has no bare SOC_opt). */
export function socColumns(columns: string[]): string[] {
  if (columns.includes('SOC_opt')) return ['SOC_opt']
  return columns.filter((c) => /^SOC_opt_\d+$/.test(c)).sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)))
}

/** The planned SOC of a row: the single battery's, or the first battery's. */
export function socOf(row: PlanRow | null | undefined): number | null {
  if (!row) return null
  const column = socColumns(Object.keys(row))[0]
  return column ? num(row, column) : null
}

const COLUMN_LABELS: Record<string, string> = {
  P_PV: 'PV',
  P_Load: 'House load',
  P_batt: 'Battery',
  P_grid: 'Grid',
  P_grid_pos: 'Grid import',
  P_grid_neg: 'Grid export',
  P_PV_curtailment: 'PV curtailed',
  P_hybrid_inverter: 'Hybrid inverter',
  SOC_opt: 'SOC',
  unit_load_cost: 'Import price',
  unit_prod_price: 'Export price',
  optim_status: 'Solver status',
  cost_profit: 'Cost or profit',
}

/** A plan column in words ("P_batt" → "Battery"); unknown columns keep EMHASS's name. */
export function planColumnLabel(column: string): string {
  const known = COLUMN_LABELS[column]
  if (known) return known
  const deferrable = /^P_deferrable(\d+)$/.exec(column)
  if (deferrable) return `Deferrable ${Number(deferrable[1]) + 1}`
  const soc = /^SOC_opt_(\d+)$/.exec(column)
  if (soc) return `SOC battery ${Number(soc[1]) + 1}`
  return column
}

/** The unit a plan column is shown in. */
export function planColumnUnit(column: string): string {
  if (/^P_/.test(column)) return 'kW'
  if (/^SOC_opt/.test(column)) return '%'
  if (column === 'unit_load_cost' || column === 'unit_prod_price') return 'c/kWh'
  return ''
}

/** A plan cell in its column's unit: W as kW, SOC as %, prices in c/kWh. */
export function formatPlanCell(column: string, value: unknown): string {
  if (!isNumber(value)) return value === null || value === undefined ? '—' : String(value)
  switch (planColumnUnit(column)) {
    case 'kW':
      return (value / 1000).toFixed(2)
    case '%':
      return (value * 100).toFixed(1)
    case 'c/kWh':
      return (value * 100).toFixed(1)
    default:
      return Math.abs(value) >= 10 ? String(Math.round(value)) : value.toFixed(4)
  }
}

export interface PlanChange {
  time: number
  timestamp: string
  battNow: number | null
  battBefore: number | null
  gridNow: number | null
  gridBefore: number | null
}

/** Slots present in both plans where battery or grid power moved by more than `thresholdW`. */
export function planChanges(current: PlanRow[], previous: PlanRow[], thresholdW = 500): PlanChange[] {
  const before = new Map<number, PlanRow>()
  for (const row of previous) {
    const t = rowTime(row)
    if (t !== null) before.set(t, row)
  }
  const out: PlanChange[] = []
  for (const row of current) {
    const t = rowTime(row)
    if (t === null) continue
    const old = before.get(t)
    if (!old) continue
    const battNow = num(row, 'P_batt')
    const battBefore = num(old, 'P_batt')
    const gridNow = num(row, 'P_grid')
    const gridBefore = num(old, 'P_grid')
    const moved = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) > thresholdW
    if (moved(battNow, battBefore) || moved(gridNow, gridBefore)) {
      out.push({ time: t, timestamp: String(row.timestamp), battNow, battBefore, gridNow, gridBefore })
    }
  }
  return out
}

/** Columns aligned to the plan's slot starts, plus a closing point so the last step has a width. */
export function stepSeries(rows: PlanRow[], columns: string[]): { x: number[]; ys: (number | null)[][] } {
  const timed = rows.map((r) => [rowTime(r), r] as const).filter((p): p is readonly [number, PlanRow] => p[0] !== null)
  const x = timed.map(([t]) => t)
  const ys = columns.map((c) => timed.map(([, r]) => num(r, c)))
  const last = x[x.length - 1]
  if (last !== undefined) {
    x.push(last + SLOT_S)
    for (const y of ys) y.push(y[y.length - 1] ?? null)
  }
  return { x, ys }
}

/** Values of `column` from `rows` placed on the time grid `x` (null where the row is missing). */
export function alignTo(x: number[], rows: PlanRow[], column: string): (number | null)[] {
  const byTime = new Map<number, number | null>()
  for (const row of rows) {
    const t = rowTime(row)
    if (t !== null) byTime.set(t, num(row, column))
  }
  return x.map((t) => byTime.get(t) ?? null)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** Why EMHASS's last run isn't "ok", in words, and whether the plan shown predates it; null when it is ok. */
export function lastRunNote(
  lastRun: Record<string, unknown> | null | undefined,
  generatedAt: string | null | undefined,
  now: Date = new Date(),
  tz?: string,
): string | null {
  const status = text(lastRun?.status)
  if (!lastRun || !status || status === 'ok') return null
  const action = text(lastRun.action) ?? 'optimisation'
  const at = text(lastRun.timestamp)
  const stages = (lastRun.stage_times ?? {}) as Record<string, unknown>
  const solved = typeof stages['optim_solve.solve'] === 'number' ? (stages['optim_solve.solve'] as number) : null
  const why =
    text(lastRun.error_message) ??
    text(lastRun.optim_status) ??
    (solved !== null
      ? `EMHASS gave no reason; its solver ran ${Math.round(solved)} s, most likely into its time limit (lp_solver_timeout)`
      : 'EMHASS gave no reason')
  let note = `EMHASS's last run (${action}${at ? `, ${formatTime(at, now, tz)}` : ''}) ended with "${status}": ${why}.`
  if (at && generatedAt && Date.parse(at) - Date.parse(generatedAt) > 1000) {
    note += ` EMHASS keeps serving its last good plan, from ${formatTime(generatedAt, now, tz)}, which is shown here.`
  }
  return note
}

/** What "made for someone else" means. */
export const EXTERNAL_PLAN_NOTE =
  "EMHASS Lens didn't send the request that made this plan: EMHASS's own web UI, a Home Assistant automation or " +
  'script, or the HACS integration with its Auto MPC switch off made it. Before 0.3.9 it could also be a ' +
  'cost-function comparison plan left in EMHASS after a failed live run.'
