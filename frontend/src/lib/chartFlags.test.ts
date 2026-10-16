import { describe, expect, it } from 'vitest'
import { groupFlags, layoutFlags } from './chartFlags'

describe('layoutFlags', () => {
  it('puts each flag at its start, inside the plot', () => {
    expect(
      layoutFlags(
        [
          { id: 'a', at: 100, widths: [80, 20] },
          { id: 'b', at: 980, widths: [80, 20] },
        ],
        0,
        1000,
      ),
    ).toEqual([
      { id: 'a', left: 100, width: 80, text: 0, row: 0 },
      { id: 'b', left: 920, width: 80, text: 0, row: 0 }, // pushed back inside the right edge
    ])
  })

  it('shortens the left of two flags that would touch, and moves one that has no room even short to the second row', () => {
    const flags = layoutFlags(
      [
        { id: 'a', at: 100, widths: [80, 20] },
        { id: 'b', at: 150, widths: [80, 20] },
        { id: 'c', at: 160, widths: [80, 20] },
      ],
      0,
      1000,
    )
    expect(flags).toEqual([
      { id: 'a', left: 100, width: 20, text: 1, row: 0 },
      { id: 'b', left: 150, width: 20, text: 1, row: 0 },
      // no room in the first row even short: the second row, at its longest text
      { id: 'c', left: 160, width: 80, text: 0, row: 1 },
    ])
    expect(layoutFlags([{ id: 'a', at: 100, widths: [80, 20] }, { id: 'b', at: 190, widths: [80, 20] }], 0, 1000)).toEqual([
      { id: 'a', left: 100, width: 80, text: 0, row: 0 },
      { id: 'b', left: 190, width: 80, text: 0, row: 0 },
    ])
    expect(layoutFlags([{ id: 'a', at: 100, widths: [80, 20] }, { id: 'b', at: 150, widths: [30, 20] }], 0, 1000)).toEqual([
      { id: 'a', left: 100, width: 20, text: 1, row: 0 },
      { id: 'b', left: 150, width: 30, text: 0, row: 0 },
    ])
  })

  it('never shortens a right flag that stays where it is: that makes no room', () => {
    // a wider SELL right after a BUY: the BUY steps back, the SELL keeps its text (it used to lose it for nothing)
    expect(layoutFlags([{ id: 'a', at: 100, widths: [60, 20] }, { id: 'b', at: 150, widths: [120, 20] }], 0, 1000)).toEqual([
      { id: 'a', left: 100, width: 20, text: 1, row: 0 },
      { id: 'b', left: 150, width: 120, text: 0, row: 0 },
    ])
    // pushed in from the plot's right edge, a shorter right flag moves right and does make room
    expect(layoutFlags([{ id: 'a', at: 800, widths: [80, 20] }, { id: 'b', at: 990, widths: [120, 20] }], 0, 1000)).toEqual([
      { id: 'a', left: 800, width: 80, text: 0, row: 0 },
      { id: 'b', left: 980, width: 20, text: 1, row: 0 },
    ])
  })

  it('keeps the hovered flag at its longest text, the others make room', () => {
    const flags = layoutFlags(
      [
        { id: 'a', at: 100, widths: [80, 20] },
        { id: 'b', at: 200, widths: [300, 20], hovered: true },
      ],
      0,
      1000,
    )
    expect(flags).toEqual([
      { id: 'a', left: 100, width: 80, text: 0, row: 0 },
      { id: 'b', left: 200, width: 300, text: 0, row: 0 },
    ])
    expect(
      layoutFlags(
        [
          { id: 'a', at: 100, widths: [120, 20] },
          { id: 'b', at: 150, widths: [300, 20], hovered: true },
        ],
        0,
        1000,
      ),
    ).toEqual([
      { id: 'a', left: 100, width: 20, text: 1, row: 0 }, // the one before steps back to its short text
      { id: 'b', left: 150, width: 300, text: 0, row: 0 },
    ])
  })
})

describe('groupFlags', () => {
  const item = (id: string, at: number, group: string) => ({ id, at, group })
  // a run's flag: 50 px, and 10 px more for its " +N"
  const width = (run: unknown[]) => 50 + 10 * (run.length - 1)

  it('puts sessions of one direction whose flags would touch under one flag', () => {
    const runs = groupFlags([item('b2', 110, 'buy'), item('b1', 100, 'buy'), item('b3', 300, 'buy'), item('s', 320, 'sell')], width)
    expect(runs.map((r) => r.map((i) => i.id))).toEqual([['b1', 'b2'], ['b3'], ['s']])
  })

  it('grows the run while the next session starts within its widened flag', () => {
    const runs = groupFlags([item('a', 0, 'buy'), item('b', 40, 'buy'), item('c', 62, 'buy'), item('d', 80, 'buy')], width)
    // a+b: 60 px, so c at 62 joins; a+b+c: 70 px, so d at 80 is still within 70 + 4? no: its own flag
    expect(runs.map((r) => r.map((i) => i.id))).toEqual([['a', 'b', 'c'], ['d']])
  })

  it('never joins sessions of the other direction', () => {
    const runs = groupFlags([item('b', 100, 'buy'), item('s', 105, 'sell')], width)
    expect(runs.map((r) => r.map((i) => i.id))).toEqual([['b'], ['s']])
  })
})

describe('layoutFlags: two rows', () => {
  it('leaves a flag out only when neither row has room for it', () => {
    const flags = layoutFlags(
      [
        { id: 'a', at: 100, widths: [80, 20] },
        { id: 'b', at: 105, widths: [80, 20] },
        { id: 'c', at: 110, widths: [80, 20] },
      ],
      0,
      1000,
    )
    expect(flags.map((f) => [f.id, f.row])).toEqual([
      ['a', 0],
      ['b', 1],
    ])
  })
})
