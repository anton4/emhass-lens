import { describe, expect, it } from 'vitest'
import type { PriceSlot } from '../api/types'
import {
  forecastRanges,
  importComponents,
  localDay,
  localDays,
  midnights,
  originLabel,
  periodLabel,
  stackLayers,
  type PricePart,
} from './prices'
import { batteryDirection, formatAge, formatPower, formatPrice, gridDirection } from './units'

const TZ = 'Europe/Tallinn'

function slot(start: string, origin = 'actual', extra: Partial<PriceSlot> = {}): PriceSlot {
  const end = new Date(Date.parse(start) + 900_000).toISOString()
  return {
    start, end, origin, period: 'day', reason: 'day', spot: 0.1, margin: 0.003, renewable: 0.008, excise: 0.002,
    balancing: 0.004, supply_security: 0.008, network: 0.037, tariff_ex_vat: 0.062, vat: 0.039,
    import_price: 0.201, export_fees: 0.014, export_price: 0.086, ...extra,
  }
}

describe('price helpers', () => {
  it('groups slots by local day in the tariff timezone', () => {
    // 21:00Z on Oct 8 is 00:00 on Oct 9 in Tallinn (EEST)
    expect(localDay('2026-10-08T21:00:00Z', TZ)).toBe('2026-10-09')
    expect(localDay('2026-10-08T20:45:00Z', TZ)).toBe('2026-10-08')
    const slots = [slot('2026-10-08T20:45:00Z'), slot('2026-10-08T21:00:00Z')]
    expect(localDays(slots, TZ)).toEqual(['2026-10-08', '2026-10-09'])
    expect(midnights(slots, TZ)).toEqual([Date.parse('2026-10-08T21:00:00Z') / 1000])
  })

  it('merges contiguous forecast slots into ranges', () => {
    const slots = [
      slot('2026-10-10T21:30:00Z'),
      slot('2026-10-10T21:45:00Z', 'forecast:ee_eupowerprices'),
      slot('2026-10-10T22:00:00Z', 'forecast:ee_eupowerprices'),
    ]
    const start = Date.parse('2026-10-10T21:45:00Z') / 1000
    expect(forecastRanges(slots)).toEqual([[start, start + 1800]])
    expect(originLabel('forecast:ee_eupowerprices')).toBe('Forecast (eupowerprices.com)')
    expect(originLabel('actual')).toBe('Nord Pool')
  })

  it('splits the import price into chart components', () => {
    const c = importComponents(slot('2026-10-09T10:00:00Z'))
    expect(c.fees).toBeCloseTo(0.025)
    expect(c.spot + c.fees + c.network + c.vat).toBeCloseTo(c.total, 2)
    expect(periodLabel('holiday_peak')).toBe('Weekend peak')
  })

  it('formats energy units and directions', () => {
    expect(formatPower(850)).toBe('850 W')
    expect(formatPower(-12345)).toMatch(/-12[.,]35 kW/)
    expect(formatPower(null)).toBe('—')
    expect(formatPrice(0.12345, 'cents')).toBe('12.35 c/kWh')
    expect(formatPrice(0.12345)).toBe('0.1235 €/kWh')
    expect(batteryDirection(-3000)).toBe('Charging')
    expect(batteryDirection(2000)).toBe('Discharging')
    expect(gridDirection(-10)).toBe('Exporting')
    expect(formatAge(34)).toBe('34 s')
    expect(formatAge(7800)).toBe('2 h 10 min')
  })
})

describe('price breakdown stacking', () => {
  const c = { spot: 10, fees: 2, network: 3, vat: 4, total: 19 }
  const all = new Set<PricePart>(['spot', 'fees', 'network', 'vat'])

  it('stacks the shown parts on top of each other without gaps', () => {
    expect(stackLayers([c], all)).toEqual({
      spot: { lo: [0], hi: [10] },
      fees: { lo: [10], hi: [12] },
      network: { lo: [12], hi: [15] },
      vat: { lo: [15], hi: [19] },
    })
  })

  it('leaves a hidden part as a layer of no thickness where it would start', () => {
    expect(stackLayers([c], new Set<PricePart>(['fees', 'vat']))).toEqual({
      spot: { lo: [0], hi: [0] },
      fees: { lo: [0], hi: [2] },
      network: { lo: [2], hi: [2] },
      vat: { lo: [2], hi: [6] },
    })
  })

  it('draws a negative spot below zero and stacks the rest from zero', () => {
    const layers = stackLayers([{ ...c, spot: -5 }], new Set<PricePart>(['spot', 'network']))
    expect(layers.spot).toEqual({ lo: [0], hi: [-5] })
    expect(layers.fees).toEqual({ lo: [0], hi: [0] })
    expect(layers.network).toEqual({ lo: [0], hi: [3] })
  })
})
