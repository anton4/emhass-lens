import { describe, expect, it } from 'vitest'
import { holdUntilNext, stripCounts, stripItems, stripLabels, stripRuns } from './dayStrip'

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

  it('carries the fill, the line, the quiet flag and the detail', () => {
    const [item] = stripItems(
      [{ t: DAY, fill: 'var(--mode-force-charge)', band: 'var(--line-green)', quiet: true, detail: { run: 7 } }],
      DAY,
      END,
      900,
    )
    expect(item).toMatchObject({
      fill: 'var(--mode-force-charge)',
      band: 'var(--line-green)',
      quiet: true,
      detail: { run: 7 },
    })
    expect(stripItems([{ t: DAY }], DAY, END, 900)[0]).toMatchObject({ fill: null, band: null, quiet: false })
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

  it('lets quiet names give way and hangs a name at the end of the day to the left', () => {
    const items = stripItems(
      [
        { t: DAY, label: 'Self-use', quiet: true },
        { t: DAY + 1800, label: 'Force charge' }, // overlaps the quiet name before it, which gives way
        { t: DAY + 6 * 3600, label: 'Self-use', quiet: true },
        { t: END - 900, label: 'Force discharge' },
      ],
      DAY,
      END,
      900,
    )
    const labels = stripLabels(items, 1000)
    expect(labels.map((l) => l.text)).toEqual(['Force charge', 'Self-use', 'Force discharge'])
    expect(labels.map((l) => l.end)).toEqual([false, false, true])
    // on a wide strip there is room for all of them
    expect(stripLabels(items, 4000)).toHaveLength(4)
  })
})

describe('stripRuns', () => {
  it('starts a run where the fill changes or the marks stop touching', () => {
    const items = stripItems(
      [
        { t: DAY, fill: 'a' },
        { t: DAY + 900, fill: 'a' },
        { t: DAY + 1800, fill: 'b' },
        { t: DAY + 3600, fill: 'b' }, // a slot missing before it
      ],
      DAY,
      END,
      900,
    )
    expect(stripRuns(items)).toEqual([
      { start: true, end: false },
      { start: false, end: true },
      { start: true, end: true },
      { start: true, end: true },
    ])
  })

  it('groups marks without a fill by the comparison', () => {
    const items = stripItems([{ t: DAY, compare: 'ok' }, { t: DAY + 900, compare: 'ok' }], DAY, END, 900)
    expect(stripRuns(items)).toEqual([
      { start: true, end: false },
      { start: false, end: true },
    ])
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
