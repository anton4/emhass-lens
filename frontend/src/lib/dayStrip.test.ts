import { describe, expect, it } from 'vitest'
import {
  agreeRuns,
  agreeText,
  dayHours,
  formatSpan,
  holdStretches,
  keyCounts,
  labelFits,
  segmentText,
  stretchDiffers,
  stretchTally,
  stretchText,
  stripCounts,
  stripItems,
  stripRuns,
  stripSegments,
} from './dayStrip'

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

  it('carries the fill, the ink, the write and the detail', () => {
    const [item] = stripItems(
      [{ t: DAY, fill: 'var(--mode-force-charge)', ink: 'black', wrote: true, detail: { run: 7 } }],
      DAY,
      END,
      900,
    )
    expect(item).toMatchObject({
      fill: 'var(--mode-force-charge)',
      ink: 'black',
      wrote: true,
      detail: { run: 7 },
    })
    expect(stripItems([{ t: DAY }], DAY, END, 900)[0]).toMatchObject({ fill: null, ink: null, wrote: false })
  })

  it('leaves out decisions of other days and trims the last slot at midnight', () => {
    const items = stripItems([{ t: DAY - 900 }, { t: END }, { t: END - 300, compare: 'ok' }], DAY, END, 900)
    expect(items).toHaveLength(1)
    expect(items[0]?.w).toBeCloseTo(300 / 86400)
  })
})

describe('stripSegments', () => {
  it('joins touching marks with the same name and fill into one stretch, and leaves unnamed ones out', () => {
    const items = stripItems(
      [
        { t: DAY, label: 'Self-use', fill: 'lilac', ink: 'black' },
        { t: DAY + 900, label: 'Self-use', fill: 'lilac', ink: 'black' },
        { t: DAY + 1800, label: 'Force charge', fill: 'blue', ink: 'white' },
        { t: DAY + 2700 }, // no name
        { t: DAY + 3600, label: 'Force charge', fill: 'blue', ink: 'white' },
        { t: DAY + 4500, label: 'Force charge', fill: 'stripes' }, // same name, another fill
        { t: DAY + 7200, label: 'Force charge', fill: 'stripes' }, // a slot missing before it
      ],
      DAY,
      END,
      900,
    )
    const segments = stripSegments(items)
    expect(segments.map((s) => [s.names, s.from, s.to, s.ink])).toEqual([
      [['Self-use'], 0, 1, 'black'],
      [['Force charge'], 2, 2, 'white'],
      [['Force charge'], 4, 4, 'white'],
      [['Force charge'], 5, 5, null],
      [['Force charge'], 6, 6, null],
    ])
    expect(segments[0]?.x).toBe(0)
    expect(segments[0]?.w).toBeCloseTo(1800 / 86400)
  })
})

describe('labelFits and segmentText', () => {
  it('fits a name of 7 px a character with 16 px of padding, 12 more on a chip', () => {
    expect(labelFits('Self-use', 72)).toBe(true) // 8 × 7 + 16
    expect(labelFits('Self-use', 71)).toBe(false)
    expect(labelFits('Self-use', 72, true)).toBe(false)
    expect(labelFits('Self-use', 84, true)).toBe(true)
  })

  it('takes the first name that fits, longest first', () => {
    const names = ['Force charge · 3.0 kW', 'Force charge']
    expect(segmentText(names, 400)).toBe('Force charge · 3.0 kW')
    expect(segmentText(names, 120)).toBe('Force charge')
    expect(segmentText(names, 60)).toBeNull()
  })
})

describe('dayHours', () => {
  const tz = 'Europe/Tallinn'
  it('marks the 24 hours of a day and its end', () => {
    const hours = dayHours('2026-10-10', tz)
    expect(hours).toHaveLength(25)
    expect(hours[0]).toEqual({ t: DAY, label: '00:00', hour: 0 })
    expect(hours[3]).toEqual({ t: DAY + 3 * 3600, label: '03:00', hour: 3 })
    expect(hours.at(-1)).toEqual({ t: END, label: '24:00', hour: 24 })
  })

  it('has 03:00 twice on the day the clocks go back, and no 03:00 on the day they go forward', () => {
    const back = dayHours('2026-10-25', tz)
    expect(back).toHaveLength(26)
    expect(back.map((h) => h.label).slice(2, 6)).toEqual(['02:00', '03:00', '03:00', '04:00'])
    expect(back.at(-1)!.t - back[0]!.t).toBe(25 * 3600)
    const forward = dayHours('2026-03-29', tz)
    expect(forward).toHaveLength(24)
    expect(forward.map((h) => h.label).slice(2, 4)).toEqual(['02:00', '04:00'])
    expect(forward.at(-1)!.t - forward[0]!.t).toBe(23 * 3600)
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

describe('holdStretches', () => {
  it('lets each decision hold until the next, within bounds', () => {
    const held = holdStretches([{ t: DAY + 600 }, { t: DAY }, { t: DAY + 630 }], 900)
    expect(held.map((h) => h.span)).toEqual([600, 60, 900])
    const items = stripItems(held, DAY, END, 900)
    expect(items[0]?.w).toBeCloseTo(600 / 86400)
  })

  it('makes one mark of consecutive decisions with the same label, held until the next mark', () => {
    const held = holdStretches(
      [
        { t: DAY, label: 'Kratt sell 3000W', runId: 1 },
        { t: DAY + 10, label: 'Kratt sell 3000W', runId: 2 },
        { t: DAY + 70, label: 'Kratt sell 3000W', runId: 3 },
        { t: DAY + 100, label: 'session end', runId: 4 },
      ],
      900,
    )
    expect(held.map((h) => [h.t, h.span, h.label, h.runId])).toEqual([
      [DAY, 100, 'Kratt sell 3000W', 1],
      [DAY + 100, 900, 'session end', 4],
    ])
    expect(held[0]?.detail).toMatchObject({ from: DAY, last: DAY + 70, decisions: 3 })
  })

  it('starts a new mark after a gap longer than the hold, with some slack', () => {
    const held = holdStretches(
      [
        { t: DAY, label: 'none' },
        { t: DAY + 901, label: 'none' },
        { t: DAY + 901 + 961, label: 'none' },
      ],
      900,
    )
    expect(held.map((h) => [h.t, h.span])).toEqual([
      [DAY, 901 + 900],
      [DAY + 901 + 961, 900],
    ])
  })

  it('never merges decisions without a label', () => {
    expect(holdStretches([{ t: DAY }, { t: DAY + 60 }], 900)).toHaveLength(2)
  })

  it('differs if any decision did, opening the first that differed', () => {
    const [mixed, agreed, unknown] = holdStretches(
      [
        { t: DAY, label: 'a', compare: 'ok', runId: 1 },
        { t: DAY + 60, label: 'a', compare: 'mismatch', runId: 2 },
        { t: DAY + 120, label: 'a', compare: 'mismatch', runId: 3 },
        { t: DAY + 180, label: 'a', runId: 4 },
        { t: DAY + 240, label: 'b', runId: 5 },
        { t: DAY + 300, label: 'b', compare: 'ok', runId: 6 },
        { t: DAY + 360, label: 'c', runId: 7, detail: 'Charge from the plan' },
      ],
      900,
    )
    expect(mixed).toMatchObject({ compare: 'mismatch', runId: 2, detail: { same: 1, differs: 2, decisions: 4 } })
    expect(agreed).toMatchObject({ compare: 'ok', runId: 5, detail: { same: 1, differs: 0, title: 'b' } })
    expect(unknown).toMatchObject({ compare: null, detail: { title: 'Charge from the plan' } })
  })

  it("takes a mark's fill and ink from its first decision, and wrote if any of them did", () => {
    const sell = 'orange'
    const [shadow, live] = holdStretches(
      [
        { t: DAY, label: 'Kratt sell 3000W', fill: sell, compare: 'ok' },
        { t: DAY + 60, label: 'Kratt sell 3000W', fill: sell, compare: 'mismatch' },
        { t: DAY + 120, label: 'no action', fill: 'grey', ink: 'black' },
        { t: DAY + 180, label: 'no action', fill: 'grey', ink: 'white', wrote: true },
      ],
      900,
    )
    expect(shadow).toMatchObject({ fill: sell, ink: null, wrote: false, compare: 'mismatch', detail: { fill: sell } })
    expect(live).toMatchObject({ fill: 'grey', ink: 'black', wrote: true })
  })
})

describe('agreeRuns', () => {
  it('joins compared marks with one outcome across the time between them, and breaks at a mark not compared', () => {
    const items = stripItems(
      [
        { t: DAY, compare: 'ok' },
        { t: DAY + 900, compare: 'ok' },
        { t: DAY + 3600, compare: 'ok' }, // after a gap: still the same run
        { t: DAY + 4500, compare: 'mismatch' },
        { t: DAY + 5400, compare: 'mismatch' },
        { t: DAY + 6300, compare: 'ok' },
        { t: DAY + 7200 }, // not compared
        { t: DAY + 8100, compare: 'ok' },
      ],
      DAY,
      END,
      900,
    )
    const runs = agreeRuns(items)
    expect(runs.map((r) => [r.state, r.items, r.same, r.differs])).toEqual([
      ['same', [0, 1, 2], 3, 0],
      ['differs', [3, 4], 0, 2],
      ['same', [5], 1, 0],
      ['same', [7], 1, 0],
    ])
    expect(runs[0]?.x).toBe(0)
    expect(runs[0]?.w).toBeCloseTo(4500 / 86400)
  })

  it('counts the decisions in each mark when told how', () => {
    const held = holdStretches(
      [
        { t: DAY, label: 'a', compare: 'ok' },
        { t: DAY + 60, label: 'a', compare: 'mismatch' },
      ],
      900,
    )
    const items = stripItems(held, DAY, END, 900)
    const [run] = agreeRuns(items, stretchTally)
    expect(run).toMatchObject({ state: 'differs', same: 1, differs: 1 })
    expect(stretchDiffers(items[0]!)).toBe('1 of 2 decisions differed')
  })
})

describe('agreeText', () => {
  it('says how many slots or decisions agreed or differed', () => {
    expect(agreeText({ state: 'same', same: 1, differs: 0 }, 'slot')).toBe('The automation did the same.')
    expect(agreeText({ state: 'same', same: 34, differs: 0 }, 'slot')).toBe('The automation did the same in all 34 slots.')
    expect(agreeText({ state: 'differs', same: 0, differs: 1 }, 'slot')).toBe('The automation did something else.')
    expect(agreeText({ state: 'differs', same: 0, differs: 2 }, 'slot')).toBe(
      'The automation did something else in all 2 slots.',
    )
    expect(agreeText({ state: 'differs', same: 3, differs: 1 }, 'decision')).toBe(
      'The automation did something else in 1 of 4 decisions.',
    )
  })
})

describe('formatSpan', () => {
  it('reads a stretch of the day with its length, the next midnight as 24:00', () => {
    const tz = 'Europe/Tallinn'
    expect(formatSpan(DAY + 5 * 3600, DAY + 5.25 * 3600, tz)).toBe('05:00–05:15 · 15 min')
    expect(formatSpan(DAY + 21 * 3600, END, tz)).toBe('21:00–24:00 · 3 h')
  })
})

describe('keyCounts', () => {
  it('counts the decisions per key entry, in the order given and the others after', () => {
    const marks = [
      { key: 'No action', fill: 'grey' },
      { key: 'Market buy', fill: 'blue' },
      null,
      { key: 'Odd', fill: 'red' },
      { key: 'No action', fill: 'grey' },
    ]
    expect(keyCounts(marks, ['Market sell', 'Market buy', 'No action'])).toEqual([
      { text: 'Market buy', fill: 'blue', count: 1 },
      { text: 'No action', fill: 'grey', count: 2 },
      { text: 'Odd', fill: 'red', count: 1 },
    ])
  })
})

describe('stretchText', () => {
  const s = { from: DAY, last: DAY, title: null, decisions: 1, same: 0, differs: 0 }
  it('names how one decision compared', () => {
    expect(stretchText({ ...s, same: 1 })).toBe('The automation did the same.')
    expect(stretchText({ ...s, differs: 1 })).toBe('The automation did something else.')
    expect(stretchText(s)).toBe('Not compared with the automation.')
  })
  it('counts several decisions, leaving out the zeros', () => {
    expect(stretchText({ ...s, decisions: 7, same: 4 })).toBe('7 decisions: 4 the same as the automation, 3 not compared.')
    expect(stretchText({ ...s, decisions: 3, same: 2, differs: 1 })).toBe(
      '3 decisions: 2 the same as the automation, 1 different.',
    )
  })
})
