// The Inputs page's price breakdown: what the slots in view cost on average, how much of it is spot, the cheapest and
// dearest of them, the chart's title for the window shown, and the tariff's parts as a footnote.

import type { PriceSlot, PricesResponse } from '../api/types'
import type { ChartNote } from '../components/charts/TimeChart'
import { cursorTimeLabel, dayDateLabel, dayTimeLabel } from './chartTime'
import { shiftDay } from './days'
import { localDay, priceExtremes } from './prices'

type Tariff = NonNullable<PricesResponse['tariff']>

const startOf = (s: PriceSlot) => Date.parse(s.start) / 1000
const endOf = (s: PriceSlot) => Date.parse(s.end) / 1000

/** The slots that overlap `window` (unix s), or all of them without one. */
export function slotsIn(slots: readonly PriceSlot[], window: [number, number] | null): PriceSlot[] {
  if (!window) return [...slots]
  return slots.filter((s) => endOf(s) > window[0] && startOf(s) < window[1])
}

export interface PriceSummary {
  slots: number
  /** The mean import price, €/kWh. */
  average: number
  /** The spot price's share of what the slots cost, with the VAT on it (0–1); null when they cost nothing. */
  spotShare: number | null
  cheapest: PriceSlot
  dearest: PriceSlot
}

/** The breakdown's tiles over `slots`. The VAT on the spot is `vatPct`, else each slot's VAT in proportion. The
 *  cheapest and dearest are the first of equals. */
export function priceSummary(slots: readonly PriceSlot[], vatPct: number | null | undefined): PriceSummary | null {
  const first = slots[0]
  if (!first) return null
  let cheapest = first
  let dearest = first
  let total = 0
  let spot = 0
  for (const s of slots) {
    total += s.import_price
    const base = s.import_price - s.vat
    const rate = typeof vatPct === 'number' ? vatPct / 100 : base !== 0 ? s.vat / base : 0
    spot += s.spot * (1 + rate)
    if (s.import_price < cheapest.import_price) cheapest = s
    if (s.import_price > dearest.import_price) dearest = s
  }
  return { slots: slots.length, average: total / slots.length, spotShare: total > 0 ? spot / total : null, cheapest, dearest }
}

const iso = (t: number) => new Date(t * 1000).toISOString()
const isMidnight = (t: number, timeZone: string) => cursorTimeLabel(t, timeZone, false) === '00:00'

/** The breakdown's title for the window shown: "Fri 16 Oct · today" for one whole day, "Fri 16 Oct · 12:45–16:30"
 *  within one, "Thu 15 Oct – Sat 17 Oct" for whole days, else "Thu 15:30 → Sun 05:00". */
export function windowTitle(window: [number, number], nowS: number, timeZone: string): string {
  const [a, b] = window
  const dayA = localDay(iso(a), timeZone)
  const dayB = localDay(iso(b - 1), timeZone)
  const whole = isMidnight(a, timeZone) && isMidnight(b, timeZone)
  if (dayA === dayB) {
    if (!whole) return `${dayDateLabel(a, timeZone)} · ${cursorTimeLabel(a, timeZone, false)}–${cursorTimeLabel(b, timeZone, false)}`
    const today = localDay(iso(nowS), timeZone)
    const near =
      dayA === today ? ' · today' : dayA === shiftDay(today, 1) ? ' · tomorrow' : dayA === shiftDay(today, -1) ? ' · yesterday' : ''
    return `${dayDateLabel(a, timeZone)}${near}`
  }
  if (whole) return `${dayDateLabel(a, timeZone)} – ${dayDateLabel(b - 1, timeZone)}`
  return `${dayTimeLabel(a, timeZone)} → ${dayTimeLabel(b, timeZone)}`
}

/** The tariff's parts as the breakdown's footnote: "Fees: margin 0.33 c, …. Network: day 3.69 c, night 2.10 c
 *  (22:00–07:00). VAT 24 %." In cents, or in euros with four decimals. */
export function tariffNote(tariff: Tariff, cents: boolean): string {
  const v = (x: number) => (cents ? `${(x * 100).toFixed(2)} c` : `${x.toFixed(4)} €`)
  const fees = [
    ['margin', tariff.margin],
    ['renewable', tariff.renewable],
    ['excise', tariff.excise],
    ['balancing', tariff.balancing],
    ['supply security', tariff.supply_security],
  ] as const
  const network = [`day ${v(tariff.network_day)}`, `night ${v(tariff.network_night)} (${tariff.night_window})`]
  if (typeof tariff.network_day_peak === 'number') network.push(`day peak ${v(tariff.network_day_peak)}`)
  if (typeof tariff.network_holiday_peak === 'number') network.push(`weekend peak ${v(tariff.network_holiday_peak)}`)
  return `Fees: ${fees.map(([name, x]) => `${name} ${v(x)}`).join(', ')}. Network: ${network.join(', ')}. VAT ${Number(tariff.vat_pct.toFixed(2))} %.`
}

// up to this window the callouts name each day's cheapest and dearest; over a longer one only the window's own
const PER_DAY_S = 36 * 3600

/** The cheapest and dearest quarter-hour as callouts over their columns ("cheapest 0.071 at 03:15"), on the chart's
 *  scale (€ or cents): each local day's while the window is a day or so, else the window's own. */
export function extremeNotes(
  slots: readonly PriceSlot[],
  timeZone: string,
  cents: boolean,
  window: [number, number] | null = null,
): ChartNote[] {
  const f = cents ? 100 : 1
  const text = (v: number) => (cents ? `${(v * f).toFixed(1)} c` : v.toFixed(3))
  const note = (what: string, p: { t: number; value: number }): ChartNote => ({
    t: p.t + 450,
    value: p.value * f,
    text: `${what} ${text(p.value)} at ${cursorTimeLabel(p.t, timeZone, false)}`,
    color: '--ink',
    look: 'callout',
  })
  const point = (s: PriceSlot) => ({ t: startOf(s), value: s.import_price })
  let pairs = priceExtremes([...slots], timeZone)
  const span = window ? window[1] - window[0] : slots.length > 0 ? endOf(slots[slots.length - 1]!) - startOf(slots[0]!) : 0
  if (span > PER_DAY_S) {
    const summary = priceSummary(slotsIn(slots, window), null)
    pairs = summary ? [{ cheapest: point(summary.cheapest), dearest: point(summary.dearest) }] : []
  }
  return pairs.flatMap((d) => [note('cheapest', d.cheapest), note('dearest', d.dearest)])
}
