// History on the Plan page: measured values next to what the plan said at the time (GET /api/plan/history),
// drawn on the same time axis as the current plan.

import type { HistorySlot, PlanPrice, PlanRow } from '../api/types'
import { num, rowTime, SLOT_S } from './plan'

export const HISTORY_WINDOWS = [6, 24, 48, 168] as const
export type HistoryHours = (typeof HISTORY_WINDOWS)[number]

export const HORIZONS = [
  { slots: 0, label: 'Plan in force' },
  { slots: 4, label: '1 h ahead' },
  { slots: 24, label: '6 h ahead' },
  { slots: 96, label: '24 h ahead' },
] as const
export type HorizonSlots = (typeof HORIZONS)[number]['slots']
export const HORIZON_SLOTS = HORIZONS.map((h) => h.slots) as readonly HorizonSlots[]

export const HOURS_KEY = 'emhass-lens.plan.history-hours'
export const HORIZON_KEY = 'emhass-lens.plan.horizon'

export function windowLabel(hours: number): string {
  return hours % 24 === 0 && hours >= 48 ? `${hours / 24} d` : `${hours} h`
}

/** A remembered numeric choice (this browser only); anything odd or blocked storage means the fallback. */
export function loadPref<T extends number>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    const value = Number(raw)
    return allowed.find((a) => a === value) ?? fallback
  } catch {
    return fallback
  }
}

export function savePref(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // not remembered, still works for this visit
  }
}

export function slotTime(slot: HistorySlot): number {
  return Date.parse(slot.start) / 1000
}

/** Where the past ends: the first slot after the last history slot (the server's current slot), else now's slot. */
export function pastEnd(history: HistorySlot[], nowS: number): number {
  const last = history[history.length - 1]
  return last ? slotTime(last) + SLOT_S : Math.floor(nowS / SLOT_S) * SLOT_S
}

/** The charts' time grid: every history slot and every plan row (sorted, no duplicates), plus a closing point. */
export function timeGrid(history: HistorySlot[], rows: PlanRow[]): number[] {
  const set = new Set<number>()
  for (const s of history) set.add(slotTime(s))
  for (const r of rows) {
    const t = rowTime(r)
    if (t !== null) set.add(t)
  }
  const x = [...set].sort((a, b) => a - b)
  const last = x[x.length - 1]
  if (last !== undefined) x.push(last + SLOT_S)
  return x
}

/** Repeats the last value one point further so the last step has a width (stepped series end at a point). */
export function closeSteps(values: (number | null)[]): (number | null)[] {
  const out = [...values]
  let last = -1
  for (let i = 0; i < out.length; i++) if (out[i] !== null && out[i] !== undefined) last = i
  if (last >= 0 && last + 1 < out.length && (out[last + 1] === null || out[last + 1] === undefined)) {
    out[last + 1] = out[last] ?? null
  }
  return out
}

type ActualKey = keyof HistorySlot['actual']
type PlannedKey = keyof HistorySlot['planned']

/** One series on grid `x`: the measured value in the past (history slots) and the current plan's `column`
 *  from `pastEndS` on. Quantities without a sensor just have an empty past. */
export function pastAndFuture(
  x: number[],
  history: HistorySlot[],
  measured: ActualKey | null,
  rows: PlanRow[],
  column: string,
  pastEndS: number,
  scale = 1,
  stepped = true,
): (number | null)[] {
  const byTime = new Map<number, number | null>()
  if (measured) {
    for (const s of history) {
      const v = s.actual[measured]
      byTime.set(slotTime(s), v === null || v === undefined ? null : v * scale)
    }
  }
  for (const r of rows) {
    const t = rowTime(r)
    if (t === null || t < pastEndS) continue
    const v = num(r, column)
    byTime.set(t, v === null ? null : v * scale)
  }
  const values = x.map((t) => byTime.get(t) ?? null)
  return stepped ? closeSteps(values) : values
}

/** What the plan said for each past slot (at the chosen look-ahead), on grid `x`; nothing in the future.
 *  Stepped series get a closing point; lines (`stepped` false) end at their last value. */
export function plannedAtTheTime(
  x: number[],
  history: HistorySlot[],
  key: PlannedKey,
  scale = 1,
  stepped = true,
): (number | null)[] {
  const byTime = new Map<number, number | null>()
  for (const s of history) {
    const v = s.planned[key]
    byTime.set(slotTime(s), v === null || v === undefined ? null : v * scale)
  }
  const values = x.map((t) => byTime.get(t) ?? null)
  return stepped ? closeSteps(values) : values
}

/** The sum of the deferrable-load columns per plan row from `pastEndS` on, on grid `x`. */
export function deferrableFuture(x: number[], rows: PlanRow[], columns: string[], pastEndS: number): (number | null)[] {
  const byTime = new Map<number, number | null>()
  for (const r of rows) {
    const t = rowTime(r)
    if (t === null || t < pastEndS) continue
    let sum: number | null = null
    for (const c of columns) {
      const v = num(r, c)
      if (v !== null) sum = (sum ?? 0) + v
    }
    byTime.set(t, sum)
  }
  return closeSteps(x.map((t) => byTime.get(t) ?? null))
}

/** Past prices (history) and the plan's prices on one list, sorted by start; the past wins on a shared slot. */
export function mergePrices(past: PlanPrice[], future: PlanPrice[]): PlanPrice[] {
  const byStart = new Map<string, PlanPrice>()
  for (const p of future) byStart.set(p.start, p)
  for (const p of past) byStart.set(p.start, p)
  return [...byStart.values()].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
}

/** The past region to shade: from the first point of the grid to where the past ends. */
export function pastShade(x: number[], pastEndS: number): [number, number][] {
  const first = x[0]
  return first !== undefined && first < pastEndS ? [[first, pastEndS]] : []
}

/** Does any history slot carry a measured value for this quantity? */
export function hasMeasured(history: HistorySlot[], key: ActualKey): boolean {
  return history.some((s) => s.actual[key] !== null && s.actual[key] !== undefined)
}

/** Does any history slot carry a planned value for this quantity? */
export function hasPlanned(history: HistorySlot[], key: PlannedKey): boolean {
  return history.some((s) => s.planned[key] !== null && s.planned[key] !== undefined)
}
