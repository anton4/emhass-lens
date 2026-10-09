// EMHASS plan rows (GET /api/plan): one object per 15-minute slot, columns vary with the EMHASS
// configuration (see EMHASS docs/plan_output_schema.md). Signs: P_batt > 0 discharge, P_grid > 0 import.

import type { PlanRow } from '../api/types'
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
  return columns
    .filter((c) => /^P_deferrable\d+$/.test(c))
    .sort((a, b) => Number(a.slice(12)) - Number(b.slice(12)))
}

export function hasColumn(rows: PlanRow[], column: string): boolean {
  return rows.some((r) => isNumber(r[column]))
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
