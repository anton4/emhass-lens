// The Inputs page's "What EMHASS gets" (GET /api/inputs/sent): one MPC payload on a time axis, after what was
// measured before its anchor. Lanes under the charts show the tariff period, the export limit and each deferrable
// load's window; the PV chart labels each day's total.

import type { ChartLane, ChartNote } from '../components/charts/TimeChart'
import type { PopupExtra } from '../components/charts/cursorStore'
import type { SentDeferrable, SentInputs } from '../api/types'
import { isForecast, periodLabel } from './prices'
import { formatPower, isNumber } from './units'

export const SLOT_S = 900

export interface SentAxis {
  /** Slot starts (unix s): the measured slots, then the payload's, then the end of the last one. */
  x: number[]
  /** Index in x of the first payload slot. */
  anchorIdx: number
  anchorS: number
  endS: number
}

export function sentAxis(data: Pick<SentInputs, 'measured' | 'slots'>): SentAxis {
  const measured = data.measured.map((m) => Date.parse(m.start) / 1000)
  const sent = data.slots.map((s) => Date.parse(s.start) / 1000)
  const anchorS = sent[0] ?? measured[measured.length - 1] ?? 0
  const endS = (sent[sent.length - 1] ?? anchorS - SLOT_S) + SLOT_S
  return { x: [...measured, ...sent, endS], anchorIdx: measured.length, anchorS, endS }
}

/** One value per x: `past` on the measured slots, `future` on the payload's, nothing at the closing point. */
export function onAxis(
  axis: SentAxis,
  past: readonly (number | null | undefined)[] | null,
  future: readonly (number | null | undefined)[] | null,
): (number | null)[] {
  const out: (number | null)[] = []
  for (let i = 0; i < axis.anchorIdx; i++) out.push(num(past?.[i]))
  for (let i = axis.anchorIdx; i < axis.x.length - 1; i++) out.push(num(future?.[i - axis.anchorIdx]))
  out.push(null)
  return out
}

/** Runs of equal values over the payload's slots, as [from, to) in unix s. */
export function runsOf<T>(axis: SentAxis, values: readonly T[]): { from: number; to: number; value: T }[] {
  const out: { from: number; to: number; value: T }[] = []
  values.forEach((value, i) => {
    const from = axis.x[axis.anchorIdx + i]
    if (from === undefined) return
    const last = out[out.length - 1]
    if (last && last.value === value && last.to === from) last.to = from + SLOT_S
    else out.push({ from, to: from + SLOT_S, value })
  })
  return out
}

const PERIOD_COLORS: Record<string, string> = {
  night: '--frame-strong',
  day: '--chart-grid',
  day_peak: '--tint-amber',
  holiday_peak: '--tint-amber',
}

export function tariffLane(axis: SentAxis, data: Pick<SentInputs, 'slots'>): ChartLane {
  return {
    label: 'Tariff',
    spans: runsOf(
      axis,
      data.slots.map((s) => s.period),
    ).map((r) => ({
      from: r.from,
      to: r.to,
      color: PERIOD_COLORS[r.value] ?? '--chart-grid',
      text: periodLabel(r.value).toLowerCase(),
    })),
  }
}

/** The export limit EMHASS got, or null when the payload had none (no "no export at or below" set). */
export function exportLane(axis: SentAxis, data: Pick<SentInputs, 'slots'>): ChartLane | null {
  if (!data.slots.some((s) => isNumber(s.export_max_w))) return null
  return {
    label: 'Export',
    spans: runsOf(
      axis,
      data.slots.map((s) => s.export_max_w ?? null),
    ).flatMap((r) =>
      r.value === null
        ? []
        : [{ from: r.from, to: r.to, color: '--line-green', hatch: r.value <= 0, text: formatPower(r.value) }],
    ),
  }
}

/** Where a deferrable load may run: from the anchor to its deadline (no deadline: the whole horizon). */
export function loadWindow(axis: SentAxis, load: SentDeferrable): [number, number] {
  const steps = load.on ? load.end_timesteps : (load.configured_end_timesteps ?? 0)
  return [axis.anchorS, steps > 0 ? Math.min(axis.endS, axis.anchorS + steps * SLOT_S) : axis.endS]
}

export function deferrableLanes(axis: SentAxis, loads: readonly SentDeferrable[]): ChartLane[] {
  return loads.map((load) => {
    const [from, to] = loadWindow(axis, load)
    return {
      label: load.name,
      spans: [{ from, to, color: '--q-ev', hatch: !load.on, text: load.on ? loadAsk(load) : 'off' }],
    }
  })
}

/** "11.00 kW for 0.45 h" */
export function loadAsk(load: SentDeferrable): string {
  return `${formatPower(load.nominal_power_w)} for ${hours(load.operating_hours)}`
}

/** What the payload says about each lane at t: the tariff period and the export limit. */
export function priceExtras(axis: SentAxis, data: Pick<SentInputs, 'slots'>, t: number): PopupExtra[] {
  const slot = data.slots[slotAt(axis, t)]
  if (!slot) return []
  const out: PopupExtra[] = [
    { name: 'Tariff', value: periodLabel(slot.period).toLowerCase(), color: PERIOD_COLORS[slot.period] ?? '--chart-grid' },
  ]
  if (isNumber(slot.export_max_w)) {
    out.push({ name: 'Export limit', value: formatPower(slot.export_max_w), color: '--line-green', hatch: slot.export_max_w <= 0 })
  }
  return out
}

/** The deferrable loads whose window holds t. */
export function loadExtras(axis: SentAxis, loads: readonly SentDeferrable[], t: number): PopupExtra[] {
  return loads.flatMap((load) => {
    const [from, to] = loadWindow(axis, load)
    if (t < from || t >= to) return []
    return [{ name: load.name, value: load.on ? loadAsk(load) : 'off: 0 W', color: '--q-ev', hatch: !load.on }]
  })
}

/** The payload slot index at t (negative before the anchor). */
export function slotAt(axis: SentAxis, t: number): number {
  return Math.floor((t - axis.anchorS) / SLOT_S)
}

/** Where the payload's prices are a forecast, as [from, to) in unix s. */
export function forecastRangesOn(axis: SentAxis, data: Pick<SentInputs, 'slots'>): [number, number][] {
  return runsOf(
    axis,
    data.slots.map((s) => isForecast(s.origin)),
  ).flatMap((r) => (r.value ? [[r.from, r.to] as [number, number]] : []))
}

/** Local midnights inside the axis (unix s). */
export function midnightsOn(axis: SentAxis, timeZone: string): number[] {
  const out: number[] = []
  for (let i = 1; i < axis.x.length; i++) {
    const t = axis.x[i]!
    if (dayKey(t, timeZone) !== dayKey(axis.x[i - 1]!, timeZone)) out.push(t)
  }
  return out
}

/** Energy in kWh of power values (W) per 15-minute slot. */
export function kwhOf(watts: readonly (number | null | undefined)[]): number {
  return watts.reduce<number>((sum, w) => sum + (isNumber(w) ? (w * SLOT_S) / 3600 : 0), 0) / 1000
}

const dayKeys = new Map<string, Intl.DateTimeFormat>()
function dayKey(t: number, timeZone: string): string {
  let f = dayKeys.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    dayKeys.set(timeZone, f)
  }
  return f.format(new Date(t * 1000))
}

export interface PvDay {
  /** The middle of the day's production (unix s) and its highest value: where the label goes. */
  t: number
  peak: number
  kwh: number
  /** The P10 total, for days that are all forecast. */
  p10Kwh: number | null
  measured: 'all' | 'some' | 'none'
}

/** Each local day's PV energy on the axis: measured before the anchor, the estimate after it. Days the axis cuts
 *  off while the sun is up (an incomplete total) and days with no production are left out. */
export function pvDays(
  axis: SentAxis,
  pv: readonly (number | null)[],
  p10: readonly (number | null)[],
  timeZone: string,
): PvDay[] {
  const days = new Map<string, { first: number; last: number; from: number; to: number; wh: number; p10: number; peak: number; measured: number; sent: number }>()
  for (let i = 0; i + 1 < axis.x.length; i++) {
    const t = axis.x[i]!
    const key = dayKey(t, timeZone)
    const v = pv[i] ?? 0
    let d = days.get(key)
    if (!d) {
      d = { first: i, last: i, from: -1, to: -1, wh: 0, p10: 0, peak: 0, measured: 0, sent: 0 }
      days.set(key, d)
    }
    d.last = i
    if (v > 0) {
      if (d.from < 0) d.from = t
      d.to = t + SLOT_S
      if (i < axis.anchorIdx) d.measured++
      else d.sent++
    }
    d.wh += (v * SLOT_S) / 3600
    if (i >= axis.anchorIdx) d.p10 += ((p10[i] ?? 0) * SLOT_S) / 3600
    d.peak = Math.max(d.peak, v)
  }
  const out: PvDay[] = []
  for (const d of days.values()) {
    const cut = (pv[d.first] ?? 0) > 0 || (pv[d.last] ?? 0) > 0
    if (cut || d.wh < 50) continue
    const measured = d.sent === 0 ? 'all' : d.measured > 0 ? 'some' : 'none'
    out.push({
      t: (d.from + d.to) / 2,
      peak: d.peak,
      kwh: d.wh / 1000,
      p10Kwh: measured === 'none' && p10.some((v) => isNumber(v)) ? d.p10 / 1000 : null,
      measured,
    })
  }
  return out
}

/** The PV chart's labels: each day's total above its hump, with the P10 total for forecast days. */
export function pvNotes(days: readonly PvDay[]): ChartNote[] {
  return days.map((d) => ({
    t: d.t,
    value: d.peak,
    text: `${d.kwh.toFixed(1)} kWh`,
    sub: d.p10Kwh !== null ? `P10 ${d.p10Kwh.toFixed(1)}` : d.measured === 'some' ? 'measured + forecast' : undefined,
    color: '--q-pv-ink',
  }))
}

function hours(h: number): string {
  return `${Number(h.toFixed(2))} h`
}

function num(value: number | null | undefined): number | null {
  return isNumber(value) ? value : null
}
