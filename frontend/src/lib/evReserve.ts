// PV reserved for the EV while it charges from excess solar: one sentence for the Explain table and the charger page.

import type { EvReserve } from '../api/types'
import { formatTime } from './format'
import { formatPower } from './units'

/** Wh as "22.5 kWh" (or "800 Wh" below a kilowatt-hour). */
export function formatEnergyWh(wh: number): string {
  if (Math.abs(wh) < 1000) return `${Math.round(wh)} Wh`
  return `${(wh / 1000).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kWh`
}

/** What the reservation did, or why nothing was reserved; null when the feature is off. */
export function evReserveText(reserve: EvReserve | null | undefined, tz?: string): string | null {
  if (!reserve) return null
  if (!reserve.active) return `No PV is reserved for the car: ${reserve.why}.`
  if (reserve.slots === 0 || !reserve.until) return `${reserve.why}; the forecast has no PV surplus to reserve.`
  const slots = reserve.slots === 1 ? '1 slot' : `${reserve.slots} slots`
  return (
    `${reserve.why}: ${formatEnergyWh(reserve.energy_reserved_wh)} of PV is kept for the car over ${slots}, ` +
    `up to ${formatPower(reserve.max_w)} a slot, until ${formatTime(reserve.until, new Date(), tz)}. EMHASS plans with the rest.`
  )
}
