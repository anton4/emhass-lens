// The Inputs page's "What EMHASS gets" (GET /api/inputs/sent): one MPC payload on a time axis, after what was
// measured (and the prices that applied) before its anchor and before the price and PV forecast after its horizon.
// Lanes under the charts show the tariff period, the export limit, the horizon and each deferrable load's window; the
// PV chart labels each day's total.

import type { ChartHatch, ChartLane, ChartNote, ChartOverlay } from '../components/charts/TimeChart'
import type { PopupExtra } from '../components/charts/cursorStore'
import type { HorizonOption, SentDeferrable, SentInputs } from '../api/types'
import { isForecast, periodLabel, periodLane } from './prices'
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

/** The tariff period over the whole axis: the measured slots' (the prices that applied), the payload's, then those
 *  after the horizon. */
export function tariffLane(axis: SentAxis, data: SentData): ChartLane {
  return periodLane(axis.x.slice(0, -1), [
    ...data.measured.map((m) => m.period ?? null),
    ...data.slots.map((s) => s.period),
    ...(data.beyond ?? []).map((b) => b.period),
  ])
}

/** The export limit EMHASS got, or null when the payload had none (no "no export at or below" set): green where it
 *  may export, red and hatched where it is capped at 0 W. */
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
        : r.value <= 0
          ? [
              {
                from: r.from,
                to: r.to,
                color: '--tint-red',
                ink: '--on-red',
                marks: [{ from: r.from, to: r.to, color: '--q-export-cap' }],
                text: formatPower(r.value),
              },
            ]
          : [{ from: r.from, to: r.to, color: '--tint-green', ink: '--on-green', text: formatPower(r.value) }],
    ),
  }
}

/** Where a deferrable load may run: from its first allowed timestep (the anchor when it has none) to its deadline
 *  (no deadline: the whole horizon). */
export function loadWindow(axis: SentAxis, load: SentDeferrable): [number, number] {
  const steps = load.on ? load.end_timesteps : (load.configured_end_timesteps ?? 0)
  const start = Math.min(axis.endS, axis.anchorS + Math.max(0, load.start_timesteps ?? 0) * SLOT_S)
  return [start, steps > 0 ? Math.min(axis.endS, axis.anchorS + steps * SLOT_S) : axis.endS]
}

/** The windows of the deferrable loads that are on, hatched across the house load chart in the EV's colour. */
export function windowBands(axis: SentAxis, loads: readonly SentDeferrable[]): ChartHatch[] {
  return loads.flatMap((load) => {
    if (!load.on) return []
    const [from, to] = loadWindow(axis, load)
    return to > from ? [{ from, to, color: '--q-ev' }] : []
  })
}

/** Each load that is on, named at its window's start on a pill: "EV · 11.00 kW for 2.5 h, Sat 01:00–07:00", or "…, by
 *  Sat 07:00" when it may start at once. */
export function windowNotes(axis: SentAxis, loads: readonly SentDeferrable[], timeZone: string): ChartNote[] {
  return loads.flatMap((load) => {
    if (!load.on) return []
    const [from, to] = loadWindow(axis, load)
    if (to <= from) return []
    const when = from > axis.anchorS ? `${dayTime(from, timeZone)}–${clock(to, timeZone)}` : `by ${dayTime(to, timeZone)}`
    return [
      {
        t: from,
        value: 0,
        top: true,
        look: 'pill' as const,
        align: 'right' as const,
        text: `${load.name} · ${loadAsk(load)}, ${when}`,
        color: '--ink-2',
      },
    ]
  })
}

/** Where the payload's prices turn into a forecast, on a pill at the top: "forecast from Sat 00:30". */
export function forecastNote(axis: SentAxis, data: Pick<SentInputs, 'slots'>, timeZone: string): ChartNote | null {
  const first = data.slots.find((s) => isForecast(s.origin))
  if (!first) return null
  const t = Date.parse(first.start) / 1000
  if (t >= axis.axisEndS) return null
  return { t, value: 0, top: true, look: 'pill', align: 'right', text: `forecast from ${dayTime(t, timeZone)}`, color: '--ink-2' }
}

/** The price popup's note line at t: the network period, the export limit with why, and whether the price is a
 *  forecast ("Night tariff · export limit 0 W (export price at or below 0.04 €/kWh) · forecast price"). */
export function priceNote(
  axis: SentAxis,
  data: SentData & Partial<Pick<SentInputs, 'no_export_at_or_below'>>,
  t: number,
): string | null {
  const i = slotAt(axis, t)
  const parts: string[] = []
  const tariff = (period: string | null | undefined) => period && parts.push(`${periodLabel(period)} tariff`)
  if (i < 0) {
    tariff(data.measured[axis.anchorIdx + i]?.period)
    return parts[0] ? `${parts[0]} · the price that applied` : null
  }
  if (i >= data.slots.length) {
    const after = data.beyond?.[i - data.slots.length]
    tariff(after?.period)
    if (after) parts.push('forecast after the horizon, not sent')
    return parts.length ? parts.join(' · ') : null
  }
  const slot = data.slots[i]
  if (!slot) return null
  tariff(slot.period)
  if (isNumber(slot.export_max_w)) {
    const why =
      slot.export_max_w <= 0 && isNumber(data.no_export_at_or_below)
        ? ` (export price at or below ${data.no_export_at_or_below} €/kWh)`
        : ''
    parts.push(`export limit ${formatPower(slot.export_max_w)}${why}`)
  }
  if (isForecast(slot.origin)) parts.push('forecast price')
  return parts.join(' · ')
}

const dayTimes = new Map<string, Intl.DateTimeFormat>()
const clocks = new Map<string, Intl.DateTimeFormat>()
/** "Sat 01:00" in the tariff time zone. */
function dayTime(t: number, timeZone: string): string {
  let f = dayTimes.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    dayTimes.set(timeZone, f)
  }
  return f.format(new Date(t * 1000))
}
/** "07:00". */
function clock(t: number, timeZone: string): string {
  let f = clocks.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false })
    clocks.set(timeZone, f)
  }
  return f.format(new Date(t * 1000))
}

/** "11.00 kW for 0.45 h" */
export function loadAsk(load: SentDeferrable): string {
  return `${formatPower(load.nominal_power_w)} for ${hours(load.operating_hours)}`
}

/** The deferrable loads whose window holds t. */
export function loadExtras(axis: SentAxis, loads: readonly SentDeferrable[], t: number): PopupExtra[] {
  return loads.flatMap((load) => {
    const [from, to] = loadWindow(axis, load)
    if (t < from || t >= to) return []
    return [{ name: load.name, value: load.on ? loadAsk(load) : 'off: 0 W', color: '--q-ev', hatch: !load.on }]
  })
}

type SocData = Pick<SentInputs, 'soc_init' | 'soc_final'> & Partial<Pick<SentInputs, 'soc_min' | 'soc_max'>>

const pct = (v: number) => `${Math.round(v * 100)} %`

/** The battery chart's lines, in %: soc_min and soc_max dashed across the axis, and soc_init at the anchor straight
 *  to soc_final at the end of the horizon (EMHASS plans the path between them). */
export function socOverlays(axis: SentAxis, data: SocData): ChartOverlay[] {
  const out: ChartOverlay[] = []
  const from = axis.x[0] ?? axis.anchorS
  for (const [label, v] of [
    ['soc_min', data.soc_min],
    ['soc_max', data.soc_max],
  ] as const) {
    if (isNumber(v)) {
      out.push({ label, color: '--ink-faint', width: 1.25, dash: [2, 4], base: 'none', spans: [{ from, to: axis.axisEndS, value: v * 100 }] })
    }
  }
  if (isNumber(data.soc_init) && isNumber(data.soc_final)) {
    out.push({
      label: 'soc_init → soc_final',
      color: '--ink-faint',
      width: 1.5,
      base: 'none',
      spans: [{ from: axis.anchorS, to: axis.endS, value: data.soc_init * 100, toValue: data.soc_final * 100 }],
    })
  }
  return out
}

/** soc_init at the anchor and soc_final at the end of the horizon, on pills ("soc_init 47 %"). */
export function socNotes(axis: SentAxis, data: SocData): ChartNote[] {
  const out: ChartNote[] = []
  const note = { color: '--q-soc-ink', look: 'pill' as const }
  if (isNumber(data.soc_init)) {
    out.push({ ...note, t: axis.anchorS, value: data.soc_init * 100, text: `soc_init ${pct(data.soc_init)}`, dot: 'filled', align: 'right' })
  }
  if (isNumber(data.soc_final)) {
    out.push({ ...note, t: axis.endS, value: data.soc_final * 100, text: `soc_final ${pct(data.soc_final)}`, dot: 'ring', align: 'left' })
  }
  return out
}

/** The battery popup from the anchor on: what was sent ("47 → 100 %"). */
export function socExtras(axis: SentAxis, data: SocData, t: number): PopupExtra[] {
  if (t < axis.anchorS || t >= axis.endS) return []
  const value = `${isNumber(data.soc_init) ? Math.round(data.soc_init * 100) : '—'} → ${isNumber(data.soc_final) ? pct(data.soc_final) : '— %'}`
  return [{ name: 'soc_init → soc_final', value, color: '--ink-faint' }]
}

/** The battery popup's note: the limits EMHASS keeps the plan within. */
export function socNote(data: SocData): string | null {
  if (!isNumber(data.soc_min) && !isNumber(data.soc_max)) return null
  return `Limits ${isNumber(data.soc_min) ? pct(data.soc_min) : '0 %'} (soc_min) to ${isNumber(data.soc_max) ? pct(data.soc_max) : '100 %'} (soc_max)`
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
  /** Its weekday ("Sat"). */
  day: string
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
      day: weekday(axis.x[d.first]!, timeZone),
      t: (d.from + d.to) / 2,
      peak: d.peak,
      kwh: d.wh / 1000,
      measured,
      notSent: d.beyond === 0 ? 'none' : d.measured + d.sent === 0 ? 'all' : 'some',
    })
  }
  return out
}

const weekdays = new Map<string, Intl.DateTimeFormat>()
function weekday(t: number, timeZone: string): string {
  let f = weekdays.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' })
    weekdays.set(timeZone, f)
  }
  return f.format(new Date(t * 1000))
}

/** The PV chart's labels: each day's name and total on a pill above its hump ("Sat · 23.4 kWh"). */
export function pvNotes(days: readonly PvDay[]): ChartNote[] {
  return days.map((d) => ({
    t: d.t,
    value: d.peak,
    look: 'pill' as const,
    text: `${d.day} · ${d.kwh.toFixed(1)} kWh`,
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

/** A chart's head on What EMHASS gets: its title, unit text, the payload keys it shows, and its key. */
export interface SentHead {
  title: string
  unit: string
  params: string[]
  keys: { label: string; color: string; look: 'line' | 'faded' | 'dash' | 'area' | 'hatch' }[]
}

/** The four charts' heads: what each draws and which of the payload's keys it comes from. */
export function sentHeads(
  data: Pick<SentInputs, 'load_source' | 'pv_sensors' | 'measured' | 'deferrables' | 'slots' | 'model'> &
    Partial<Pick<SentInputs, 'soc_min' | 'soc_max' | 'beyond'>>,
  o: { cents: boolean; hoursBack: number },
): { prices: SentHead; pv: SentHead; load: SentHead; soc: SentHead } {
  const measured = o.hoursBack > 0 && data.measured.length > 0
  const past = (color: string) => (measured ? [{ label: 'measured', color, look: 'faded' as const }] : [])
  const forecast = data.slots.some((s) => isForecast(s.origin)) || (data.beyond ?? []).length > 0
  const exportCap = data.slots.some((s) => isNumber(s.export_max_w))
  const windows = data.deferrables.filter((d) => d.on)
  const starts = data.deferrables.some((d) => d.start_source)
  const sent = data.load_source === 'sent'
  return {
    prices: {
      title: 'Prices sent',
      unit: `${o.cents ? 'c/kWh' : '€/kWh'}, fees and VAT included`,
      params: ['load_cost_forecast', 'prod_price_forecast', ...(exportCap ? ['maximum_power_to_grid'] : [])],
      keys: [
        { label: 'import', color: '--q-import', look: 'line' },
        { label: 'export', color: '--q-export', look: 'line' },
        ...(forecast ? [{ label: 'forecast', color: '--chart-hatch', look: 'hatch' as const }] : []),
      ],
    },
    pv: {
      title: 'PV forecast sent',
      unit: `kW · Solcast, ${data.pv_sensors} day sensor${data.pv_sensors === 1 ? '' : 's'}`,
      params: ['pv_power_forecast'],
      keys: [{ label: 'forecast sent', color: '--q-pv', look: 'area' }, ...past('--q-pv')],
    },
    load: {
      title: sent ? 'House load sent' : 'House load',
      unit: sent ? 'kW · from the extra runtime parameters' : "kW · EMHASS's own ML forecast, not sent",
      params: [
        sent ? 'load_power_forecast' : (data.model?.var_model ? 'var_model' : 'load_forecast_method'),
        ...(windows.length > 0 ? ['end_timesteps_of_each_deferrable_load'] : []),
        ...(starts ? ['start_timesteps_of_each_deferrable_load'] : []),
      ],
      keys: [
        { label: sent ? 'sent' : 'forecast', color: '--q-load', look: 'area' },
        ...past('--q-load'),
        ...windows.map((d) => ({ label: `${d.name} window`, color: '--q-ev', look: 'hatch' as const })),
      ],
    },
    soc: {
      title: 'Battery',
      unit: '% · from the measured state of charge to the target at the end of the horizon',
      params: ['soc_init', 'soc_final'],
      keys: [
        ...past('--q-soc'),
        { label: 'soc_init → soc_final', color: '--ink-faint', look: 'line' },
        ...(isNumber(data.soc_min) || isNumber(data.soc_max)
          ? [
              {
                label: `limits ${isNumber(data.soc_min) ? Math.round(data.soc_min * 100) : 0}–${isNumber(data.soc_max) ? Math.round(data.soc_max * 100) : 100} %`,
                color: '--ink-faint',
                look: 'dash' as const,
              },
            ]
          : []),
      ],
    },
  }
}
