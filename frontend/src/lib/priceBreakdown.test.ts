import { describe, expect, it } from 'vitest'
import type { PriceSlot, PricesResponse } from '../api/types'
import { priceSummary, slotsIn, tariffNote, windowTitle } from './priceBreakdown'

const TZ = 'Europe/Tallinn'
const at = (iso: string) => Date.parse(iso) / 1000
// Fri 16 Oct 00:00 in Tallinn
const DAY = at('2026-10-15T21:00:00Z')

function slot(k: number, extra: Partial<PriceSlot> = {}): PriceSlot {
  const start = DAY + k * 900
  return {
    start: new Date(start * 1000).toISOString(),
    end: new Date((start + 900) * 1000).toISOString(),
    origin: 'actual',
    period: 'day',
    reason: 'day',
    spot: 0.1,
    margin: 0.003,
    renewable: 0.008,
    excise: 0.002,
    balancing: 0.004,
    supply_security: 0.008,
    network: 0.037,
    tariff_ex_vat: 0.062,
    vat: 0.03888,
    import_price: 0.20088,
    export_fees: 0.014,
    export_price: 0.086,
    ...extra,
  }
}

describe('slotsIn', () => {
  it('keeps the slots that overlap the window, or all without one', () => {
    const slots = [slot(0), slot(1), slot(2), slot(3)]
    expect(slotsIn(slots, [DAY + 900, DAY + 1800]).map((s) => s.start)).toEqual([slots[1]!.start])
    expect(slotsIn(slots, [DAY + 1000, DAY + 1900])).toHaveLength(2)
    expect(slotsIn(slots, null)).toHaveLength(4)
  })
})

describe('priceSummary', () => {
  it('gives the mean, the spot share with its VAT, and the first cheapest and dearest slot', () => {
    const slots = [slot(0), slot(1, { spot: 0.02, vat: 0.01968, import_price: 0.10168 }), slot(2), slot(3, { spot: 0.02, vat: 0.01968, import_price: 0.10168 })]
    const s = priceSummary(slots, 24)!
    expect(s.slots).toBe(4)
    expect(s.average).toBeCloseTo(0.15128, 5)
    // (2 × 0.1 + 2 × 0.02) × 1.24 / (2 × 0.20088 + 2 × 0.10168)
    expect(s.spotShare).toBeCloseTo(0.2976 / 0.60512, 5)
    expect(s.cheapest).toBe(slots[1])
    expect(s.dearest).toBe(slots[0])
  })

  it('takes the VAT from each slot without a tariff, and has no share when nothing costs anything', () => {
    expect(priceSummary([slot(0)], null)!.spotShare).toBeCloseTo((0.1 * 1.24) / 0.20088, 4)
    expect(priceSummary([slot(0, { spot: -0.062, vat: 0, import_price: 0 })], 24)!.spotShare).toBeNull()
    expect(priceSummary([], 24)).toBeNull()
  })
})

describe('windowTitle', () => {
  const now = at('2026-10-16T12:00:00Z')

  it('names a whole day, with today, tomorrow or yesterday', () => {
    expect(windowTitle([DAY, DAY + 86400], now, TZ)).toBe('Fri 16 Oct · today')
    expect(windowTitle([DAY + 86400, DAY + 2 * 86400], now, TZ)).toBe('Sat 17 Oct · tomorrow')
    expect(windowTitle([DAY - 86400, DAY], now, TZ)).toBe('Thu 15 Oct · yesterday')
    expect(windowTitle([DAY + 2 * 86400, DAY + 3 * 86400], now, TZ)).toBe('Sun 18 Oct')
  })

  it('names part of a day, whole days, or a stretch across days', () => {
    expect(windowTitle([DAY + 12.75 * 3600, DAY + 16.5 * 3600], now, TZ)).toBe('Fri 16 Oct · 12:45–16:30')
    expect(windowTitle([DAY - 86400, DAY + 2 * 86400], now, TZ)).toBe('Thu 15 Oct – Sat 17 Oct')
    expect(windowTitle([DAY + 15.5 * 3600, DAY + 2 * 86400 + 5 * 3600], now, TZ)).toBe('Fri 15:30 → Sun 05:00')
  })

  it('takes the 25-hour day at the end of summer time as one day', () => {
    const sun = at('2026-10-24T21:00:00Z')
    expect(windowTitle([sun, sun + 25 * 3600], now, TZ)).toBe('Sun 25 Oct')
  })
})

describe('tariffNote', () => {
  const tariff: NonNullable<PricesResponse['tariff']> = {
    package: 'Custom',
    margin: 0.00328,
    renewable: 0.0084,
    excise: 0.0021,
    balancing: 0.00373,
    supply_security: 0.00758,
    network_day: 0.0369,
    network_night: 0.021,
    network_day_peak: null,
    network_holiday_peak: null,
    night_window: '22:00–07:00',
    vat_pct: 24,
    export_margin: 0.01,
    export_balancing: 0.00373,
  }

  it('lists the fees, the network rates and the VAT', () => {
    expect(tariffNote(tariff, true)).toBe(
      'Fees: margin 0.33 c, renewable 0.84 c, excise 0.21 c, balancing 0.37 c, supply security 0.76 c. Network: day 3.69 c, night 2.10 c (22:00–07:00). VAT 24 %.',
    )
    expect(tariffNote({ ...tariff, network_day_peak: 0.0819 }, false)).toContain('night 0.0210 € (22:00–07:00), day peak 0.0819 €.')
  })
})
