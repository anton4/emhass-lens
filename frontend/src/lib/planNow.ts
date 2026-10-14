// The Plan page's this slot: what is measured now next to the plan, and what the inverter is set to.

import type { ChargerNow, ControlNow, InverterNow, NowQuantity } from '../api/types'
import { formatSlot } from './format'
import { batteryDirection, formatPower, gridDirection, isNumber } from './units'

export type NowByKey = Partial<Record<'batt' | 'grid' | 'pv' | 'load' | 'soc', NowQuantity>>

export function byKey(quantities: NowQuantity[] | null | undefined): NowByKey {
  const out: NowByKey = {}
  for (const q of quantities ?? []) out[q.key as keyof NowByKey] = q
  return out
}

/** The EV box's sensor, for its age and hover text: the charger entity its power last changed from. Never judged. */
export function evSensor(charger: ChargerNow | null | undefined): NowQuantity | undefined {
  if (!charger?.entity) return undefined
  return { key: 'ev', entity: charger.entity, age_s: charger.age_s, sign_hint: false }
}

export interface ControlFact {
  market: boolean
  /** "EMHASS" or "Market" */
  label: string
  /** "sell 5.00 kW (kratt) since 10:12", or "market not watched" */
  detail: string
  title: string
}

/** The Plan page's Mode: whether the EMHASS plan or a Qilowatt market session drives the inverter now. A session
 *  that began on another day shows its weekday. */
export function controlFact(control: ControlNow | null | undefined, now: Date, timeZone: string): ControlFact | null {
  if (!control) return null
  if (control.mode !== 'market') {
    return control.watched
      ? { market: false, label: 'EMHASS', detail: '', title: 'The EMHASS plan drives the inverter: no market session holds it' }
      : {
          market: false,
          label: 'EMHASS',
          detail: 'market not watched',
          title:
            'EMHASS Lens doesn’t watch market sessions, so one may hold the inverter unseen. Turn on Settings → Market session hold, or Qilowatt market control.',
        }
  }
  const parts = [
    control.value ?? 'session',
    isNumber(control.power_w) ? formatPower(control.power_w) : null,
    control.source ? `(${control.source})` : null,
    control.since ? `since ${formatSlot(control.since, now, timeZone)}` : null,
  ]
  const by =
    control.run_by === 'app'
      ? 'EMHASS Lens runs this Qilowatt market session and hands the inverter back to the plan when it ends'
      : `The Home Assistant automation runs this market session${control.entity ? ` (${control.entity} is ${control.value ?? '?'})` : ''}; the plan is re-applied when it ends`
  return {
    market: true,
    label: 'Market',
    detail: parts.filter(Boolean).join(' '),
    title: `${by}. Until then MPC runs are built but not sent, and the plan isn’t applied.`,
  }
}

/** A power is off when it is this far off and this share of the larger of the two (domain/plan_now.py's rule). */
export const POWER_W = 300
const POWER_SHARE = 0.15

export function powerDiffers(a: number | null | undefined, b: number | null | undefined): boolean {
  if (!isNumber(a) || !isNumber(b)) return false
  const gap = Math.abs(a - b)
  return gap > POWER_W && gap > POWER_SHARE * Math.max(Math.abs(a), Math.abs(b))
}

/** "expected 744 W discharging with the house load and PV now" for the battery or the grid; null otherwise. */
export function expectedText(q: NowQuantity | undefined, past = false): string | null {
  if (!q || (q.key !== 'batt' && q.key !== 'grid') || !isNumber(q.expected)) return null
  const given = past ? 'the measured house load and PV' : 'the house load and PV now'
  const way = (q.key === 'batt' ? batteryDirection(q.expected) : gridDirection(q.expected)).toLowerCase()
  return `expected ${formatPower(Math.abs(q.expected))} ${way} with ${given}`
}

/** The inverter's mode and passive state: "Passive Mode · Self-use battery or PV". */
export function inverterMode(inv: InverterNow): string {
  return [inv.charger_mode, inv.state].filter(Boolean).join(' · ')
}

/** The pieces of the "Inverter set to" line; `withMode` false leaves out the mode when a chip already shows it. */
export function inverterParts(inv: InverterNow, withMode = true): string[] {
  const parts: string[] = []
  const mode = inverterMode(inv)
  if (mode && withMode) parts.push(mode)
  if (isNumber(inv.grid_power_w)) parts.push(`grid target ${formatPower(inv.grid_power_w)}`)
  if (isNumber(inv.battery_min_w) && isNumber(inv.battery_max_w)) {
    const kw = (w: number) => String(Number((w / 1000).toFixed(1)))
    parts.push(`battery ${kw(inv.battery_min_w)} … ${kw(inv.battery_max_w)} kW`)
  }
  if (isNumber(inv.feedin_max_w)) parts.push(`feed-in limit ${formatPower(inv.feedin_max_w)}`)
  return parts
}
