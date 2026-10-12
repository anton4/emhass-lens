import { describe, expect, it } from 'vitest'
import { columnGap, columnSegment, inRanges, slotIndex } from './chartColumns'

describe('the gap between columns', () => {
  it('is 2 px for a day of quarter-hours on a desktop and shrinks as columns get thin', () => {
    expect(columnGap(10.3)).toBe(2) // 96 slots across ~990 px
    expect(columnGap(8)).toBe(2)
    expect(columnGap(3.4)).toBe(1) // three days across ~990 px, or a day on a phone
    expect(columnGap(2.2)).toBe(0.5)
    expect(columnGap(1.1)).toBe(0) // too thin: the columns touch
  })
})

describe('a part of a stacked column', () => {
  it('steps back from the part it sits on', () => {
    expect(columnSegment(0.08, 0.1063)).toEqual({ from: 0.08, to: 0.1063, inset: 'low' })
  })

  it('starts on zero without a gap', () => {
    expect(columnSegment(0, 0.08)).toEqual({ from: 0, to: 0.08, inset: null })
  })

  it('steps back from zero when it is below it (a negative spot)', () => {
    expect(columnSegment(0, -0.012)).toEqual({ from: -0.012, to: 0, inset: 'high' })
  })

  it('is nothing when it has no thickness (a part switched off)', () => {
    expect(columnSegment(0.08, 0.08)).toBeNull()
  })
})

describe('the slot under the pointer', () => {
  // three quarter-hour slots and the closing point
  const starts = [0, 900, 1800, 2700]

  it('is the slot the value falls in, not the nearest start', () => {
    expect(slotIndex(starts, 0)).toBe(0)
    expect(slotIndex(starts, 800)).toBe(0) // nearer 900, still the first slot
    expect(slotIndex(starts, 900)).toBe(1)
    expect(slotIndex(starts, 2650)).toBe(2)
  })

  it('never picks the closing point and clamps before the first slot', () => {
    expect(slotIndex(starts, 2700)).toBe(2)
    expect(slotIndex(starts, 9999)).toBe(2)
    expect(slotIndex(starts, -50)).toBe(0)
    expect(slotIndex([], 5)).toBe(0)
  })
})

describe('a slot in a forecast', () => {
  it('lies wholly inside one of the ranges', () => {
    const ranges: [number, number][] = [[1800, 3600]]
    expect(inRanges(1800, 2700, ranges)).toBe(true)
    expect(inRanges(900, 1800, ranges)).toBe(false)
    expect(inRanges(900, 2700, ranges)).toBe(false)
  })
})
