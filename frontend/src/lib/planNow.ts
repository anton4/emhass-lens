// The Plan page's this slot: what is measured now next to the plan, and what the inverter is set to.

import type { ChargerNow, InverterNow, NowQuantity } from '../api/types'
import { batteryDirection, formatFraction, formatPower, gridDirection, isNumber } from './units'

export type NowByKey = Partial<Record<'batt' | 'grid' | 'pv' | 'load' | 'soc', NowQuantity>>

export function byKey(quantities: NowQuantity[] | null | undefined): NowByKey {
  const out: NowByKey = {}
  for (const q of quantities ?? []) out[q.key as keyof NowByKey] = q
  return out
}

/** "now 0.12 kW discharging", "now 312 W", "now 92.3 %"; null when nothing is measured. */
export function measuredText(q: NowQuantity | undefined): string | null {
  if (!q || !isNumber(q.measured)) return null
  const v = q.measured
  if (q.key === 'soc') return `now ${formatFraction(v)}`
  if (q.key === 'batt') return `now ${formatPower(Math.abs(v))} ${batteryDirection(v).toLowerCase()}`
  if (q.key === 'grid') return `now ${formatPower(Math.abs(v))} ${gridDirection(v).toLowerCase()}`
  return `now ${formatPower(v)}`
}

/** "expected 744 W discharging with the house load and PV now" for the battery; null otherwise. */
export function expectedText(q: NowQuantity | undefined): string | null {
  if (!q || q.key !== 'batt' || !isNumber(q.expected)) return null
  return `expected ${formatPower(Math.abs(q.expected))} ${batteryDirection(q.expected).toLowerCase()} with the house load and PV now`
}

/** Hover text: what the battery is expected to do, which sensor, and how old its value is. */
export function measuredTitle(q: NowQuantity | undefined): string | undefined {
  if (!q?.entity) return undefined
  const age = isNumber(q.age_s) ? `, ${q.age_s < 90 ? `${Math.round(q.age_s)} s` : `${Math.round(q.age_s / 60)} min`} old` : ''
  const expected = expectedText(q)
  return `${expected ? `${expected} · ` : ''}${q.entity}${age}`
}

/** The pieces of the "Inverter set to" strip. */
export function inverterParts(inv: InverterNow): string[] {
  const parts: string[] = []
  const mode = [inv.charger_mode, inv.state].filter(Boolean).join(' · ')
  if (mode) parts.push(mode)
  if (isNumber(inv.grid_power_w)) parts.push(`grid target ${formatPower(inv.grid_power_w)}`)
  if (isNumber(inv.battery_min_w) && isNumber(inv.battery_max_w)) {
    const kw = (w: number) => String(Number((w / 1000).toFixed(1)))
    parts.push(`battery ${kw(inv.battery_min_w)} … ${kw(inv.battery_max_w)} kW`)
  }
  if (isNumber(inv.feedin_max_w)) parts.push(`feed-in limit ${formatPower(inv.feedin_max_w)}`)
  return parts
}

/** The EV charger as the deferrable tile's second line. */
export function chargerText(ch: ChargerNow | null | undefined): string | null {
  if (!ch) return null
  if (ch.state_raw === 0) return 'EV unplugged'
  if (ch.state_raw === 4) return `EV charging at ${isNumber(ch.current_limit_a) ? ch.current_limit_a : '?'} A`
  if (ch.state_raw === null || ch.state_raw === undefined || ch.state_raw < 0) return 'EV charger state unknown'
  return 'EV plugged in, not charging'
}
