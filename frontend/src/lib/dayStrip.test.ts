import { describe, expect, it } from 'vitest'
import { holdUntilNext, stripCounts, stripItems, stripLabels } from './dayStrip'

const DAY = Date.parse('2026-10-09T21:00:00Z') / 1000 // Sat 10 Oct 00:00 in Tallinn
const END = DAY + 86400

describe('stripItems', () => {
  it('places the day decisions and colours them by the comparison', () => {
    const items = stripItems(
      [
        { t: DAY + 900, compare: 'mismatch', label: 'force_charge', runId: 2 },
        { t: DAY, compare: 'ok', label: 'force_charge', runId: 1 },
        { t: DAY + 1800, label: 'self_use' },
      ],
      DAY,
      END,
      900,
    )
    expect(items.map((i) => i.state)).toEqual(['same', 'differs', 'none'])
    expect(items[1]?.x).toBeCloseTo(900 / 86400)
    expect(items[0]?.w).toBeCloseTo(900 / 86400)
    expect(items[0]?.runId).toBe(1)
  })

  it('leaves out decisions of other days and trims the last slot at midnight', () => {
    const items = stripItems([{ t: DAY - 900 }, { t: END }, { t: END - 300, compare: 'ok' }], DAY, END, 900)
    expect(items).toHaveLength(1)
    expect(items[0]?.w).toBeCloseTo(300 / 86400)
  })
})

describe('stripLabels', () => {
  it('names a rule where it changes and skips names that would overlap', () => {
    const items = stripItems(
      [
        { t: DAY, label: 'force_charge' },
        { t: DAY + 900, label: 'force_charge' },
        { t: DAY + 1800, label: 'self_use' }, // too close to the first name
        { t: DAY + 6 * 3600, label: 'charge_export' },
        { t: DAY + 18 * 3600, label: 'force_discharge' },
      ],
      DAY,
      END,
      900,
    )
    expect(stripLabels(items).map((l) => l.text)).toEqual(['force_charge', 'charge_export', 'force_discharge'])
  })
})

describe('stripCounts', () => {
  it('counts the states', () => {
    const items = stripItems(
      [{ t: DAY, compare: 'ok' }, { t: DAY + 900, compare: 'ok' }, { t: DAY + 1800 }],
      DAY,
      END,
      900,
    )
    expect(stripCounts(items)).toEqual({ same: 2, differs: 0, none: 1 })
  })
})

describe('holdUntilNext', () => {
  it('lets each decision hold until the next, within bounds', () => {
    const held = holdUntilNext([{ t: DAY + 600 }, { t: DAY }, { t: DAY + 630 }], 900)
    expect(held.map((h) => h.span)).toEqual([600, 60, 900])
    const items = stripItems(held, DAY, END, 900)
    expect(items[0]?.w).toBeCloseTo(600 / 86400)
  })
})
