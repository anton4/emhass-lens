import { describe, expect, it } from 'vitest'
import type { BeyondSlot, HorizonOption, SentDeferrable, SentInputs } from '../api/types'
import {
  deferrableLanes,
  exportLane,
  forecastRangesOn,
  horizonLane,
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
    ev_reserved_w: 0,
    export_max_w: 15500,
    ...extra,
  }
}

type Measured = SentInputs['measured'][number]

function sent(slots: Slot[], measuredSlots = 0, past: (k: number) => Partial<Measured> = () => ({})): Pick<SentInputs, 'measured' | 'slots'> {
  const measured = Array.from({ length: measuredSlots }, (_, k) => ({
    start: iso(ANCHOR - (measuredSlots - k) * 900),
    load: 1000 + k,
    pv: null,
    soc: 0.5,
    ...past(k),
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

  it('carries the tariff lane back over the prices that applied before the anchor', () => {
    // two slots without a stored price, then day, then night from two slots before the anchor on
    const data = sent([slot(0), slot(1, { period: 'day' })], 5, (k) =>
      k < 2 ? {} : { load_cost: 0.2, prod_price: 0.1, period: k < 3 ? 'day' : 'night' },
    )
    const axis = sentAxis(data)
    expect(tariffLane(axis, data).spans).toEqual([
      { from: ANCHOR - 3 * 900, to: ANCHOR - 2 * 900, color: '--chart-grid', text: 'day' },
      { from: ANCHOR - 2 * 900, to: ANCHOR + 900, color: '--frame-strong', text: 'night' },
      { from: ANCHOR + 900, to: ANCHOR + 1800, color: '--chart-grid', text: 'day' },
    ])
    expect(onAxis(axis, data.measured.map((m) => m.load_cost), [0.25, 0.26])).toEqual([null, null, 0.2, 0.2, 0.2, 0.25, 0.26, null])
  })

  it('reads the lanes at the cursor for the popup; before the anchor only the tariff that applied', () => {
    const data = sent([slot(0), slot(1, { period: 'day', export_max_w: 0 })], 4, (k) => (k === 3 ? { period: 'day' } : {}))
    const axis = sentAxis(data)
    expect(priceExtras(axis, data, ANCHOR + 900)).toEqual([
      { name: 'Tariff', value: 'day', color: '--chart-grid' },
      { name: 'Export limit', value: '0 W', color: '--line-green', hatch: true },
    ])
    expect(priceExtras(axis, data, ANCHOR - 900)).toEqual([{ name: 'Tariff', value: 'day', color: '--chart-grid' }])
    expect(priceExtras(axis, data, ANCHOR - 1800)).toEqual([])
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

  it('totals each whole day: measured before the anchor, the estimate after it', () => {
    const days = pvDays(axis, pv, TZ)
    expect(days.map((d) => [d.kwh, d.measured])).toEqual([
      [16, 'all'],
      [16, 'none'],
    ])
    expect(pvNotes(days).map((n) => [n.text, n.sub])).toEqual([
      ['16.0 kWh', undefined],
      ['16.0 kWh', undefined],
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
    expect(pvDays(short, cut, TZ).map((d) => d.measured)).toEqual(['none'])
  })

  it('adds up energy per 15-minute slot', () => {
    expect(kwhOf([4000, 4000, null, 4000, 4000])).toBe(4)
  })
})

describe('after the horizon', () => {
  const after = (i: number, extra: Partial<BeyondSlot> = {}): BeyondSlot => ({
    start: iso(ANCHOR + i * 900),
    origin: 'forecast:ee_eupowerprices',
    period: 'night',
    load_cost: 0.2,
    prod_price: 0.1,
    pv_w: 0,
    ...extra,
  })
  const data = { ...sent([slot(0), slot(1)], 1), beyond: [after(2), after(3, { period: 'day' })] }
  const axis = sentAxis(data)

  it('follows the payload on the axis; the plan still ends with the payload', () => {
    expect(axis.x).toEqual([ANCHOR - 900, ANCHOR, ANCHOR + 900, ANCHOR + 1800, ANCHOR + 2700, ANCHOR + 3600])
    expect([axis.anchorIdx, axis.beyondIdx]).toEqual([1, 3])
    expect([axis.endS, axis.axisEndS]).toEqual([ANCHOR + 1800, ANCHOR + 3600])
    expect(onAxis(axis, [1], [2, 3], [4, null])).toEqual([1, 2, 3, 4, null, null])
    expect(onAxis(axis, [1], [2, 3])).toEqual([1, 2, 3, null, null, null])
  })

  it('carries the tariff and the forecast shading over it, and the popup gives its tariff only', () => {
    expect(tariffLane(axis, data).spans.map((s) => [s.from, s.to, s.text])).toEqual([
      [ANCHOR, ANCHOR + 2700, 'night'],
      [ANCHOR + 2700, ANCHOR + 3600, 'day'],
    ])
    expect(forecastRangesOn(axis, data)).toEqual([[ANCHOR + 1800, ANCHOR + 3600]])
    expect(priceExtras(axis, data, ANCHOR + 2700)).toEqual([{ name: 'Tariff', value: 'day', color: '--chart-grid' }])
  })

  it('draws the horizon: sent, then not sent; a previewed length moves the end', () => {
    expect(horizonLane(axis, data).spans).toEqual([
      { from: ANCHOR, to: ANCHOR + 1800, color: '--tint-green', text: 'sent · 2 slots' },
      { from: ANCHOR + 1800, to: ANCHOR + 3600, color: '--chart-grid', hatch: true, text: 'not sent' },
    ])
    const longer: HorizonOption = { days: 2, end: iso(ANCHOR + 2700), slots: 3, num_lags: 384, short: false }
    expect(horizonLane(axis, data, longer).spans).toEqual([
      { from: ANCHOR, to: ANCHOR + 2700, color: '--tint-blue', text: 'Nord Pool + 2 d · 3 slots' },
      { from: ANCHOR + 2700, to: ANCHOR + 3600, color: '--chart-grid', hatch: true, text: 'not sent' },
    ])
    expect(horizonLane(sentAxis(sent([slot(0)])), sent([slot(0)])).spans).toHaveLength(1)
  })

  it('says which PV day totals were not sent', () => {
    // Sunday measured; Monday sent until 12:00 and after the horizon from then; Tuesday cut off at 01:00
    const sentSlots = Array.from({ length: 60 }, (_, i) => slot(i))
    const afterSlots = Array.from({ length: 52 }, (_, i) => after(60 + i))
    const long = sentAxis({ ...sent(sentSlots, 96), beyond: afterSlots })
    const sunHigh = (t: number) => {
      const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date(t * 1000)))
      return h >= 9 && h < 17 ? 2000 : 0
    }
    const pv = [...long.x.slice(0, -1).map(sunHigh), null] as (number | null)[]
    const days = pvDays(long, pv, TZ)
    expect(days.map((d) => [d.measured, d.notSent])).toEqual([
      ['all', 'none'],
      ['none', 'some'],
    ])
    expect(pvNotes(days).map((n) => n.sub)).toEqual([undefined, 'partly sent'])
  })
})
