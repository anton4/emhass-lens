// The Inputs page's "What EMHASS gets" (GET /api/inputs/sent): one MPC payload on a time axis, after what was
// measured (and the prices that applied) before its anchor and before the price and PV forecast after its horizon.
// Lanes under the charts show the tariff period, the export limit, the horizon and each deferrable load's window; the
// PV chart labels each day's total.

import type { ChartLane, ChartNote } from '../components/charts/TimeChart'
import type { PopupExtra } from '../components/charts/cursorStore'
import type { HorizonOption, SentDeferrable, SentInputs } from '../api/types'
import { isForecast, periodLabel } from './prices'
import { formatPower, isNumber } from './units'

export const SLOT_S = 900

/** What the axis is built from: the slots after the horizon are optional. */
export type SentData = Pick<SentInputs, 'measured' | 'slots'> & Partial<Pick<SentInputs, 'beyond'>>

export interface SentAxis {
  /** Slot starts (unix s): the measured slots, the payload's, those after the horizon, then the end of the last. */
  x: number[]
  /** Index in x of the first payload slot. */
  anchorIdx: number
  /** Index in x of the first slot after the horizon (the closing point when there are none). */
  beyondIdx: number
  anchorS: number
  /** The end of the payload's last slot: where the plan ends. */
  endS: number
  /** The end of the axis: the last slot after the horizon, else endS. */
  axisEndS: number
}

export function sentAxis(data: SentData): SentAxis {
  const measured = data.measured.map((m) => Date.parse(m.start) / 1000)
  const sent = data.slots.map((s) => Date.parse(s.start) / 1000)
  const beyond = (data.beyond ?? []).map((b) => Date.parse(b.start) / 1000)
  const anchorS = sent[0] ?? measured[measured.length - 1] ?? 0
  const endS = (sent[sent.length - 1] ?? anchorS - SLOT_S) + SLOT_S
  const axisEndS = beyond.length > 0 ? beyond[beyond.length - 1]! + SLOT_S : endS
  return {
    x: [...measured, ...sent, ...beyond, axisEndS],
    anchorIdx: measured.length,
    beyondIdx: measured.length + sent.length,
    anchorS,
    endS,
    axisEndS,
  }
}

/** One value per x: `past` on the measured slots, `future` on the payload's, `beyond` after the horizon, nothing at
 *  the closing point. */
export function onAxis(
  axis: SentAxis,
  past: readonly (number | null | undefined)[] | null,
  future: readonly (number | null | undefined)[] | null,
  beyond: readonly (number | null | undefined)[] | null = null,
): (number | null)[] {
  const out: (number | null)[] = []
  for (let i = 0; i < axis.anchorIdx; i++) out.push(num(past?.[i]))
  for (let i = axis.anchorIdx; i < axis.beyondIdx; i++) out.push(num(future?.[i - axis.anchorIdx]))
  for (let i = axis.beyondIdx; i < axis.x.length - 1; i++) out.push(num(beyond?.[i - axis.beyondIdx]))
  out.push(null)
  return out
}

/** Runs of equal values over the payload's slots (or from slot `start` of the axis on), as [from, to) in unix s. */
export function runsOf<T>(axis: SentAxis, values: readonly T[], start = axis.anchorIdx): { from: number; to: number; value: T }[] {
  const out: { from: number; to: number; value: T }[] = []
  values.forEach((value, i) => {
    const from = axis.x[start + i]
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

/** The tariff period over the whole axis: the measured slots' (the prices that applied), the payload's, then those
 *  after the horizon. */
export function tariffLane(axis: SentAxis, data: SentData): ChartLane {
  return {
    label: 'Tariff',
    spans: runsOf(
      axis,
      [
        ...data.measured.map((m) => m.period ?? null),
        ...data.slots.map((s) => s.period),
        ...(data.beyond ?? []).map((b) => b.period),
      ],
      0,
    ).flatMap((r) =>
      r.value === null
        ? []
        : [{ from: r.from, to: r.to, color: PERIOD_COLORS[r.value] ?? '--chart-grid', text: periodLabel(r.value).toLowerCase() }],
    ),
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

/** What the payload says about each lane at t: the tariff period and the export limit; before the anchor and after
 *  the horizon only the period. */
export function priceExtras(axis: SentAxis, data: SentData, t: number): PopupExtra[] {
  const i = slotAt(axis, t)
  const tariffOnly = (period: string | null | undefined): PopupExtra[] =>
    period ? [{ name: 'Tariff', value: periodLabel(period).toLowerCase(), color: PERIOD_COLORS[period] ?? '--chart-grid' }] : []
  if (i < 0) return tariffOnly(data.measured[axis.anchorIdx + i]?.period)
  if (i >= data.slots.length) return tariffOnly(data.beyond?.[i - data.slots.length]?.period)
  const slot = data.slots[i]
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

/** Where the prices are a forecast (sent or after the horizon), as [from, to) in unix s. */
export function forecastRangesOn(axis: SentAxis, data: Omit<SentData, 'measured'>): [number, number][] {
  return runsOf(axis, [...data.slots, ...(data.beyond ?? [])].map((s) => isForecast(s.origin))).flatMap((r) =>
    r.value ? [[r.from, r.to] as [number, number]] : [],
  )
}

/** The plan's horizon under the price chart: what was sent, then (hatched) what wasn't. While a plan length is
 *  previewed, where that one would end instead. */
export function horizonLane(axis: SentAxis, data: Pick<SentInputs, 'slots'>, preview: HorizonOption | null = null): ChartLane {
  const end = preview ? Date.parse(preview.end) / 1000 : axis.endS
  const spans: ChartLane['spans'] = [
    preview
      ? { from: axis.anchorS, to: end, color: '--tint-blue', text: `Nord Pool + ${preview.days} d · ${preview.slots} slots` }
      : { from: axis.anchorS, to: end, color: '--tint-green', text: `sent · ${data.slots.length} slots` },
  ]
  if (axis.axisEndS > end) spans.push({ from: end, to: axis.axisEndS, color: '--chart-grid', hatch: true, text: 'not sent' })
  return { label: 'Horizon', spans }
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
  measured: 'all' | 'some' | 'none'
  /** How much of the day's production is after the horizon, so not sent. */
  notSent: 'all' | 'some' | 'none'
}

/** Each local day's PV energy on the axis: measured before the anchor, the estimate after it. Days the axis cuts
 *  off while the sun is up (an incomplete total) and days with no production are left out. */
export function pvDays(
  axis: SentAxis,
  pv: readonly (number | null)[],
  timeZone: string,
): PvDay[] {
  const days = new Map<
    string,
    { first: number; last: number; from: number; to: number; wh: number; peak: number; measured: number; sent: number; beyond: number }
  >()
  for (let i = 0; i + 1 < axis.x.length; i++) {
    const t = axis.x[i]!
    const key = dayKey(t, timeZone)
    const v = pv[i] ?? 0
    let d = days.get(key)
    if (!d) {
      d = { first: i, last: i, from: -1, to: -1, wh: 0, peak: 0, measured: 0, sent: 0, beyond: 0 }
      days.set(key, d)
    }
    d.last = i
    if (v > 0) {
      if (d.from < 0) d.from = t
      d.to = t + SLOT_S
      if (i < axis.anchorIdx) d.measured++
      else if (i < axis.beyondIdx) d.sent++
      else d.beyond++
    }
    d.wh += (v * SLOT_S) / 3600
    d.peak = Math.max(d.peak, v)
  }
  const out: PvDay[] = []
  for (const d of days.values()) {
    const cut = (pv[d.first] ?? 0) > 0 || (pv[d.last] ?? 0) > 0
    if (cut || d.wh < 50) continue
    const ahead = d.sent + d.beyond
    const measured = ahead === 0 ? 'all' : d.measured > 0 ? 'some' : 'none'
    out.push({
      t: (d.from + d.to) / 2,
      peak: d.peak,
      kwh: d.wh / 1000,
      measured,
      notSent: d.beyond === 0 ? 'none' : d.measured + d.sent === 0 ? 'all' : 'some',
    })
  }
  return out
}

/** The PV chart's labels: each day's total above its hump. */
export function pvNotes(days: readonly PvDay[]): ChartNote[] {
  return days.map((d) => ({
    t: d.t,
    value: d.peak,
    text: `${d.kwh.toFixed(1)} kWh`,
    sub:
      [
        d.measured === 'some' ? 'measured + forecast' : null,
        d.notSent === 'all' ? 'not sent' : d.notSent === 'some' ? 'partly sent' : null,
      ]
        .filter(Boolean)
        .join(' · ') || undefined,
    color: '--q-pv-ink',
  }))
}

function hours(h: number): string {
  return `${Number(h.toFixed(2))} h`
}

function num(value: number | null | undefined): number | null {
  return isNumber(value) ? value : null
}
