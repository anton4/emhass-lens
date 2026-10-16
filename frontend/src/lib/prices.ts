// Price slots from GET /api/prices: grouping by local day (in the tariff timezone), the component
// breakdown used by the stacked chart, and forecast ranges for shading.

import type { PriceSlot } from '../api/types'
import type { ChartLane } from '../components/charts/TimeChart'

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

// bottom to top: neighbours in this order pass the colour-vision check in both themes (--stack-*)
export const PRICE_PARTS: readonly PricePart[] = ['spot', 'network', 'fees', 'vat']

/** The breakdown's layers, slot by slot: each part's lower and upper edge. Spot goes from zero (down when
 *  negative), the other shown parts stack upward from the top of a positive spot (or from zero when spot is
 *  hidden); a hidden part is a layer of no thickness where it would start. */
export function stackLayers(
  list: Components[],
  shown: ReadonlySet<PricePart>,
): Record<PricePart, { lo: number[]; hi: number[] }> {
  const out = {
    spot: { lo: [] as number[], hi: [] as number[] },
    fees: { lo: [] as number[], hi: [] as number[] },
    network: { lo: [] as number[], hi: [] as number[] },
    vat: { lo: [] as number[], hi: [] as number[] },
  }
  for (const c of list) {
    out.spot.lo.push(0)
    out.spot.hi.push(shown.has('spot') ? c.spot : 0)
    let base = shown.has('spot') ? Math.max(c.spot, 0) : 0
    for (const key of ['network', 'fees', 'vat'] as const) {
      out[key].lo.push(base)
      if (shown.has(key)) base += c[key]
      out[key].hi.push(base)
    }
  }
  return out
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

/** The steps of the price ribbon (--heat-0 … --heat-6, cheap to dear). */
export const HEAT_STEPS = 7

/** A ribbon under the Plan's price chart: each quarter-hour coloured by its import price, in seven steps of one violet
 *  from the cheapest to the dearest (slot starts in unix s; a slot without a price is left out). With `window` the
 *  steps run from the cheapest to the dearest in it, and the slots outside take the nearest step. Neighbours in the
 *  same step are one span. */
export function priceHeatLane(
  starts: number[],
  prices: (number | null)[],
  slotS = 900,
  window?: [number, number],
): ChartLane {
  const inWindow = (t: number) => !window || (t + slotS > window[0] && t < window[1])
  const known = prices.filter((p, i): p is number => p !== null && Number.isFinite(p) && inWindow(starts[i] ?? 0))
  const all = known.length > 0 ? known : prices.filter((p): p is number => p !== null && Number.isFinite(p))
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  const step = (p: number) =>
    hi > lo ? Math.min(HEAT_STEPS - 1, Math.max(0, Math.floor(((p - lo) / (hi - lo)) * HEAT_STEPS))) : 0
  const spans: ChartLane['spans'] = []
  starts.forEach((t, i) => {
    const p = prices[i]
    if (p === null || p === undefined || !Number.isFinite(p)) return
    const color = `--heat-${step(p)}`
    const last = spans[spans.length - 1]
    if (last && last.color === color && last.to === t) last.to = t + slotS
    else spans.push({ from: t, to: t + slotS, color })
  })
  return { label: 'Import', spans }
}

/** The cheapest and dearest quarter-hour that overlaps `window` (the first of equals), or null when none does. */
export function windowExtremes(
  prices: { t: number; value: number }[],
  window: [number, number],
  slotS = 900,
): { cheapest: { t: number; value: number }; dearest: { t: number; value: number } } | null {
  let cheapest: { t: number; value: number } | null = null
  let dearest: { t: number; value: number } | null = null
  for (const p of prices) {
    if (p.t + slotS <= window[0] || p.t >= window[1]) continue
    if (!cheapest || p.value < cheapest.value) cheapest = p
    if (!dearest || p.value > dearest.value) dearest = p
  }
  return cheapest && dearest ? { cheapest, dearest } : null
}

/** Each local day's cheapest and dearest quarter-hour by import price (the first of equals), in `timeZone`. */
export function priceExtremes(
  slots: PriceSlot[],
  timeZone: string,
): { cheapest: { t: number; value: number }; dearest: { t: number; value: number } }[] {
  const days = new Map<string, PriceSlot[]>()
  for (const s of slots) {
    const day = localDay(s.start, timeZone)
    days.set(day, [...(days.get(day) ?? []), s])
  }
  return [...days.values()].map((day) => {
    let lo = day[0]!
    let hi = day[0]!
    for (const s of day) {
      if (s.import_price < lo.import_price) lo = s
      if (s.import_price > hi.import_price) hi = s
    }
    return {
      cheapest: { t: Date.parse(lo.start) / 1000, value: lo.import_price },
      dearest: { t: Date.parse(hi.start) / 1000, value: hi.import_price },
    }
  })
}