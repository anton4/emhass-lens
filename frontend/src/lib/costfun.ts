// Cost functions on the Plan page (GET /api/plan/costfun): the three plans EMHASS makes for the same inputs
// with profit, cost and self-consumption, side by side on one chart and in one table.

import type { CostfunResult, PlanRow } from '../api/types'
import { deferrableColumns, num, rowTime, socColumns, SLOT_S } from './plan'
import { closeSteps } from './planHistory'

export const METHODS = ['profit', 'cost', 'self-consumption'] as const
export type Method = (typeof METHODS)[number]

export const METHOD_LABEL: Record<Method, string> = { profit: 'Profit', cost: 'Cost', 'self-consumption': 'Self-consumption' }
export const METHOD_COLOR: Record<Method, string> = { profit: '--series-1', cost: '--series-2', 'self-consumption': '--series-3' }
export const METHOD_EXPLAINED: Record<Method, string> = {
  profit: 'import cost minus export revenue',
  cost: 'import cost only, exports earn nothing',
  'self-consumption': 'as much PV used on site as possible',
}

export const QUANTITIES = [
  { key: 'P_grid', label: 'Grid (+ import)' },
  { key: 'P_batt', label: 'Battery (+ discharge)' },
  { key: 'SOC_opt', label: 'Battery SOC' },
  { key: 'P_deferrable', label: 'Deferrable loads' },
] as const
export type QuantityKey = (typeof QUANTITIES)[number]['key']

export const SHOWN_KEY = 'emhass-lens.costfun.shown'
export const QUANTITY_KEY = 'emhass-lens.costfun.quantity'

export function isMethod(value: unknown): value is Method {
  return typeof value === 'string' && (METHODS as readonly string[]).includes(value)
}

/** Which methods are drawn (remembered in this browser); blocked storage means all three. */
export function loadShown(): Set<Method> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(SHOWN_KEY) ?? 'null')
    if (Array.isArray(saved)) return new Set(METHODS.filter((m) => saved.includes(m)))
  } catch {
    // fall through to the default
  }
  return new Set(METHODS)
}

export function saveShown(shown: Set<Method>): void {
  try {
    localStorage.setItem(SHOWN_KEY, JSON.stringify([...shown]))
  } catch {
    // not remembered, still works for this visit
  }
}

export function loadQuantity(): QuantityKey {
  try {
    const saved = localStorage.getItem(QUANTITY_KEY)
    const hit = QUANTITIES.find((q) => q.key === saved)
    if (hit) return hit.key
  } catch {
    // fall through to the default
  }
  return 'P_grid'
}

export function saveQuantity(key: QuantityKey): void {
  try {
    localStorage.setItem(QUANTITY_KEY, key)
  } catch {
    // not remembered, still works for this visit
  }
}

/** The common time grid of the compared plans (same anchor, so usually identical), plus a closing point. */
export function compareGrid(results: CostfunResult[]): number[] {
  const set = new Set<number>()
  for (const r of results) {
    for (const row of r.rows as PlanRow[]) {
      const t = rowTime(row)
      if (t !== null) set.add(t)
    }
  }
  const x = [...set].sort((a, b) => a - b)
  const last = x[x.length - 1]
  if (last !== undefined) x.push(last + SLOT_S)
  return x
}

/** One method's values of `quantity` on grid `x`: SOC in %, deferrable loads summed; stepped series closed. */
export function methodSeries(x: number[], result: CostfunResult, quantity: QuantityKey): (number | null)[] {
  const rows = result.rows as PlanRow[]
  const byTime = new Map<number, number | null>()
  const columns = Object.keys(rows[0] ?? {})
  const socColumn = socColumns(columns)[0]
  const deferrables = deferrableColumns(columns)
  for (const row of rows) {
    const t = rowTime(row)
    if (t === null) continue
    let v: number | null
    if (quantity === 'SOC_opt') {
      const raw = socColumn ? num(row, socColumn) : null
      v = raw === null ? null : raw * 100
    } else if (quantity === 'P_deferrable') {
      v = null
      for (const c of deferrables) {
        const part = num(row, c)
        if (part !== null) v = (v ?? 0) + part
      }
    } else {
      v = num(row, quantity)
    }
    byTime.set(t, v)
  }
  const values = x.map((t) => byTime.get(t) ?? null)
  return quantity === 'SOC_opt' ? values : closeSteps(values)
}

export function formatEur(value: number | null | undefined, signed = false): string {
  if (value === null || value === undefined) return '—'
  const sign = signed && value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)} €`
}

export function formatKwh(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return `${value.toFixed(1)} kWh`
}

/** The method with the lowest net cost among those that produced a plan; null when fewer than two did. */
export function cheapest(results: CostfunResult[]): Method | null {
  const priced = results.filter((r) => r.totals && isMethod(r.costfun))
  if (priced.length < 2) return null
  let best = priced[0]
  for (const r of priced) if ((r.totals?.net_cost_eur ?? Infinity) < (best?.totals?.net_cost_eur ?? Infinity)) best = r
  return best && isMethod(best.costfun) ? best.costfun : null
}
