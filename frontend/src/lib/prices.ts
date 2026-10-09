// Price slots from GET /api/prices: grouping by local day (in the tariff timezone), the component
// breakdown used by the stacked chart, and forecast ranges for shading.

import type { PriceSlot } from '../api/types'

export const PERIOD_LABELS: Record<string, string> = {
  day: 'Day',
  night: 'Night',
  day_peak: 'Day peak',
  holiday_peak: 'Weekend peak',
}

export function periodLabel(period: string): string {
  return PERIOD_LABELS[period] ?? period
}

export function isForecast(origin: string): boolean {
  return origin.startsWith('forecast:')
}

/** "ee_eupowerprices" -> "eupowerprices.com", for "forecast:<provider>" origins. */
export function originLabel(origin: string): string {
  if (origin === 'actual') return 'Nord Pool'
  const provider = origin.replace(/^forecast:/, '')
  return { ee_eupowerprices: 'Forecast (eupowerprices.com)', fi_ha_entity: 'Forecast (FI)' }[provider] ?? `Forecast (${provider})`
}

/** Local calendar day "2026-10-09" of an ISO timestamp in `timeZone`. */
export function localDay(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(iso),
  )
  return parts // en-CA formats as YYYY-MM-DD
}

export function localTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(iso),
  )
}

export function localDays(slots: PriceSlot[], timeZone: string): string[] {
  const days: string[] = []
  for (const slot of slots) {
    const day = localDay(slot.start, timeZone)
    if (days[days.length - 1] !== day) days.push(day)
  }
  return days
}

export function slotsOfDay(slots: PriceSlot[], day: string, timeZone: string): PriceSlot[] {
  return slots.filter((s) => localDay(s.start, timeZone) === day)
}

export interface Components {
  spot: number
  fees: number
  network: number
  vat: number
  total: number
}

/** Import price split into what the stacked chart shows: spot, seller+state fees, network, VAT. */
export function importComponents(slot: PriceSlot): Components {
  const fees = slot.margin + slot.renewable + slot.excise + slot.balancing + slot.supply_security
  return { spot: slot.spot, fees, network: slot.network, vat: slot.vat, total: slot.import_price }
}

export type PricePart = 'spot' | 'fees' | 'network' | 'vat'

export const PRICE_PARTS: readonly PricePart[] = ['spot', 'fees', 'network', 'vat']

/**
 * The bar pieces of one slot for the parts shown: spot from zero (down when negative), the other
 * shown parts stacked upward from the top of the positive spot (or from zero when spot is hidden).
 */
export function stackSegments(c: Components, shown: ReadonlySet<PricePart>): { key: PricePart; from: number; to: number }[] {
  const out: { key: PricePart; from: number; to: number }[] = []
  let base = 0
  if (shown.has('spot')) {
    out.push({ key: 'spot', from: 0, to: c.spot })
    base = Math.max(c.spot, 0)
  }
  for (const key of ['fees', 'network', 'vat'] as const) {
    if (!shown.has(key)) continue
    out.push({ key, from: base, to: base + c[key] })
    base += c[key]
  }
  return out
}

/** The value range the shown stacks need; zero always stays in view. */
export function stackExtent(list: Components[], shown: ReadonlySet<PricePart>): { min: number; max: number } {
  let min = 0
  let max = 0.0001
  for (const c of list) {
    for (const s of stackSegments(c, shown)) {
      min = Math.min(min, s.from, s.to)
      max = Math.max(max, s.from, s.to)
    }
  }
  return { min, max }
}

/** Contiguous [start, end] ranges (unix seconds) where the price is a forecast. */
export function forecastRanges(slots: PriceSlot[]): [number, number][] {
  const out: [number, number][] = []
  for (const slot of slots) {
    if (!isForecast(slot.origin)) continue
    const start = Date.parse(slot.start) / 1000
    const end = Date.parse(slot.end) / 1000
    const last = out[out.length - 1]
    if (last && last[1] === start) last[1] = end
    else out.push([start, end])
  }
  return out
}

/** Unix seconds of local midnights strictly inside (first, last). */
export function midnights(slots: PriceSlot[], timeZone: string): number[] {
  const out: number[] = []
  let previous: string | null = null
  for (const slot of slots) {
    const day = localDay(slot.start, timeZone)
    if (previous !== null && day !== previous) out.push(Date.parse(slot.start) / 1000)
    previous = day
  }
  return out
}
