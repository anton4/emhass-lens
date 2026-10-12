import { describe, expect, it } from 'vitest'
import type { SentDeferrable, SentInputs } from '../api/types'
import {
  deferrableLanes,
  exportLane,
  forecastRangesOn,
  kwhOf,
  loadExtras,
  loadWindow,
  midnightsOn,
  onAxis,
  priceExtras,
  pvDays,
  pvNotes,
  sentAxis,
  tariffLane,
} from './sent'

const TZ = 'Europe/Tallinn'
const ANCHOR = Date.parse('2026-10-11T18:00:00Z') / 1000 // Sun 21:00 in Tallinn
const iso = (t: number) => new Date(t * 1000).toISOString()

type Slot = SentInputs['slots'][number]

function slot(i: number, extra: Partial<Slot> = {}): Slot {
  return {
    i,
    start: iso(ANCHOR + i * 900),
    origin: 'actual',
    period: 'night',
    spot: 0.1,
    load_cost: 0.25,
    prod_price: 0.14,
    pv_w: 0,
    pv_p10_w: 0,
    ev_reserved_w: 0,
    export_max_w: 15500,
    ...extra,
  }
}

function sent(slots: Slot[], measuredSlots = 0): Pick<SentInputs, 'measured' | 'slots'> {
  const measured = Array.from({ length: measuredSlots }, (_, k) => ({
    start: iso(ANCHOR - (measuredSlots - k) * 900),
    load: 1000 + k,
    pv: null,
    soc: 0.5,
  }))
  return { measured, slots }
}

const load = (extra: Partial<SentDeferrable> = {}): SentDeferrable => ({
  name: 'EV',
  on: true,
  nominal_power_w: 11000,
  operating_hours: 0.45,
  end_timesteps: 6,
  single_constant: true,
  configured_power_w: 11000,
  configured_hours: 0.45,
  configured_end_timesteps: 6,
  enabled_source: 'input_boolean.ev_charging_enabled',
  ...extra,
})

describe('the sent payload on a time axis', () => {
  it('puts the measured slots before the anchor and closes the axis at the end of the last slot', () => {
    const axis = sentAxis(sent([slot(0), slot(1)], 2))
    expect(axis.x).toEqual([ANCHOR - 1800, ANCHOR - 900, ANCHOR, ANCHOR + 900, ANCHOR + 1800])
    expect(axis.anchorIdx).toBe(2)
    expect(axis.anchorS).toBe(ANCHOR)
    expect(axis.endS).toBe(ANCHOR + 1800)
    expect(onAxis(axis, [1, 2], [3, null])).toEqual([1, 2, 3, null, null])
    expect(onAxis(axis, null, [3, 4])).toEqual([null, null, 3, 4, null])
  })

  it('draws the tariff periods and the export limit as lanes, hatched where export is blocked', () => {
    const data = sent([slot(0), slot(1), slot(2, { period: 'day', export_max_w: 0 }), slot(3, { period: 'day', export_max_w: 0 })])
    const axis = sentAxis(data)
    expect(tariffLane(axis, data).spans).toEqual([
      { from: ANCHOR, to: ANCHOR + 1800, color: '--frame-strong', text: 'night' },
      { from: ANCHOR + 1800, to: ANCHOR + 3600, color: '--chart-grid', text: 'day' },
    ])
    expect(exportLane(axis, data)?.spans).toEqual([
      { from: ANCHOR, to: ANCHOR + 1800, color: '--line-green', hatch: false, text: '15.50 kW' },
      { from: ANCHOR + 1800, to: ANCHOR + 3600, color: '--line-green', hatch: true, text: '0 W' },
    ])
    expect(exportLane(axis, sent([slot(0, { export_max_w: null })]))).toBeNull()
  })

  it('reads the lanes at the cursor for the popup, and nothing before the anchor', () => {
    const data = sent([slot(0), slot(1, { period: 'day', export_max_w: 0 })], 4)
    const axis = sentAxis(data)
    expect(priceExtras(axis, data, ANCHOR + 900)).toEqual([
      { name: 'Tariff', value: 'day', color: '--chart-grid' },
      { name: 'Export limit', value: '0 W', color: '--line-green', hatch: true },
    ])
    expect(priceExtras(axis, data, ANCHOR - 900)).toEqual([])
  })

  it('shades the forecast prices and marks local midnights', () => {
    const slots = Array.from({ length: 16 }, (_, i) => slot(i, { origin: i >= 12 ? 'forecast:ee_eupowerprices' : 'actual' }))
    const axis = sentAxis(sent(slots))
    expect(forecastRangesOn(axis, sent(slots))).toEqual([[ANCHOR + 12 * 900, ANCHOR + 16 * 900]])
    // Sun 21:00 + 3 h is midnight in Tallinn
    expect(midnightsOn(axis, TZ)).toEqual([ANCHOR + 3 * 3600])
  })

  it('opens a deferrable load from the anchor to its deadline; an off load shows what it would ask, hatched', () => {
    const axis = sentAxis(sent(Array.from({ length: 16 }, (_, i) => slot(i))))
    expect(loadWindow(axis, load())).toEqual([ANCHOR, ANCHOR + 6 * 900])
    expect(loadWindow(axis, load({ end_timesteps: 0 }))).toEqual([ANCHOR, ANCHOR + 16 * 900])
    const off = load({ on: false, nominal_power_w: 0, operating_hours: 0, end_timesteps: 0 })
    expect(loadWindow(axis, off)).toEqual([ANCHOR, ANCHOR + 6 * 900])
    expect(deferrableLanes(axis, [load(), off]).map((l) => l.spans[0])).toEqual([
      { from: ANCHOR, to: ANCHOR + 5400, color: '--q-ev', hatch: false, text: '11.00 kW for 0.45 h' },
      { from: ANCHOR, to: ANCHOR + 5400, color: '--q-ev', hatch: true, text: 'off' },
    ])
    expect(loadExtras(axis, [off], ANCHOR + 900)).toEqual([{ name: 'EV', value: 'off: 0 W', color: '--q-ev', hatch: true }])
    expect(loadExtras(axis, [off], ANCHOR + 6 * 900)).toEqual([])
  })
})

describe('PV day totals', () => {
  // the axis runs Sat 21:00 → Tue 01:00 (Tallinn): Sunday measured, Monday forecast, Tuesday cut off at 01:00
  const measuredSlots = 96
  const slots = Array.from({ length: 112 }, (_, i) => slot(i))
  const axis = sentAxis(sent(slots, measuredSlots))
  const sunHigh = (t: number) => {
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date(t * 1000)))
    return h >= 9 && h < 17 ? 2000 : 0
  }
  const pv = axis.x.slice(0, -1).map(sunHigh) as (number | null)[]
  pv.push(null)
  const p10 = axis.x.map((t, i) => (i >= axis.anchorIdx && i < axis.x.length - 1 ? sunHigh(t) / 4 : null))

  it('totals each whole day: measured before the anchor, the estimate and its P10 after it', () => {
    const days = pvDays(axis, pv, p10, TZ)
    expect(days.map((d) => [d.kwh, d.p10Kwh, d.measured])).toEqual([
      [16, null, 'all'],
      [16, 4, 'none'],
    ])
    expect(pvNotes(days).map((n) => [n.text, n.sub])).toEqual([
      ['16.0 kWh', undefined],
      ['16.0 kWh', 'P10 4.0'],
    ])
    // over the middle of the day's production, at its peak
    expect(days[1]?.peak).toBe(2000)
    expect(days[1]?.t).toBe(Date.parse('2026-10-12T10:00:00Z') / 1000)
  })

  it('leaves out a day the axis cuts off while the sun is up', () => {
    // 40 measured slots: the axis starts Sun 11:00, in the middle of Sunday's production
    const short = sentAxis(sent(slots, 40))
    const cut = short.x.slice(0, -1).map(sunHigh) as (number | null)[]
    cut.push(null)
    const cutP10 = short.x.map((t, i) => (i >= short.anchorIdx && i < short.x.length - 1 ? sunHigh(t) / 4 : null))
    expect(pvDays(short, cut, cutP10, TZ).map((d) => d.measured)).toEqual(['none'])
  })

  it('adds up energy per 15-minute slot', () => {
    expect(kwhOf([4000, 4000, null, 4000, 4000])).toBe(4)
  })
})
