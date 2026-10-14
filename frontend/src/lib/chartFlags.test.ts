import { describe, expect, it } from 'vitest'
import { layoutFlags } from './chartFlags'

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
      { id: 'a', left: 100, width: 80, text: 0 },
      { id: 'b', left: 920, width: 80, text: 0 }, // pushed back inside the right edge
    ])
  })

  it('shortens the wider of two flags that would touch, and leaves out one that has no room even short', () => {
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
      { id: 'a', left: 100, width: 20, text: 1 },
      { id: 'b', left: 150, width: 20, text: 1 },
    ])
    expect(layoutFlags([{ id: 'a', at: 100, widths: [80, 20] }, { id: 'b', at: 190, widths: [80, 20] }], 0, 1000)).toEqual([
      { id: 'a', left: 100, width: 80, text: 0 },
      { id: 'b', left: 190, width: 80, text: 0 },
    ])
    expect(layoutFlags([{ id: 'a', at: 100, widths: [80, 20] }, { id: 'b', at: 150, widths: [30, 20] }], 0, 1000)).toEqual([
      { id: 'a', left: 100, width: 20, text: 1 },
      { id: 'b', left: 150, width: 30, text: 0 },
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
      { id: 'a', left: 100, width: 80, text: 0 },
      { id: 'b', left: 200, width: 300, text: 0 },
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
      { id: 'a', left: 100, width: 20, text: 1 }, // the one before steps back to its short text
      { id: 'b', left: 150, width: 300, text: 0 },
    ])
  })
})
