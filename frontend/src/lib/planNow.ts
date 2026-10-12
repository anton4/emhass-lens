// The Plan page's this slot: what is measured now next to the plan, and what the inverter is set to.

import type { InverterNow, NowQuantity } from '../api/types'
import { batteryDirection, formatPower, isNumber } from './units'

export type NowByKey = Partial<Record<'batt' | 'grid' | 'pv' | 'load' | 'soc', NowQuantity>>

export function byKey(quantities: NowQuantity[] | null | undefined): NowByKey {
  const out: NowByKey = {}
  for (const q of quantities ?? []) out[q.key as keyof NowByKey] = q
  return out
}

/** "expected 744 W discharging with the house load and PV now" for the battery; null otherwise. */
export function expectedText(q: NowQuantity | undefined, past = false): string | null {
  if (!q || q.key !== 'batt' || !isNumber(q.expected)) return null
  const given = past ? 'the measured house load and PV' : 'the house load and PV now'
  return `expected ${formatPower(Math.abs(q.expected))} ${batteryDirection(q.expected).toLowerCase()} with ${given}`
}

/** The pieces of the "Inverter set to" line. */
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
