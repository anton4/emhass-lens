import { describe, expect, it } from 'vitest'
import { brushState, dayLabelEvery, overviewPaths } from './overview'

describe('overviewPaths', () => {
  const x = [0, 900, 1800, 2700]
  const id = (v: number) => v

  it('draws the slots before now in one path and the rest in the other', () => {
    expect(overviewPaths(x, [1, 2, 3, 4], 1800, id, id)).toEqual({
      past: 'M0.0 1.0H900.0V2.0H1800.0',
      future: 'M1800.0 3.0H2700.0V4.0H3600.0',
    })
  })

  it('breaks the line where a value is missing', () => {
    expect(overviewPaths(x, [1, null, 3, 4], 9999, id, id).past).toBe('M0.0 1.0H900.0M1800.0 3.0H2700.0V4.0H3600.0')
  })
})

describe('dayLabelEvery', () => {
  it('names every day with room, else every second', () => {
    expect(dayLabelEvery(120)).toBe(1)
    expect(dayLabelEvery(40)).toBe(2)
  })
})

describe('brushState', () => {
  it('is idle, pointed at or dragged', () => {
    expect(brushState(null, false)).toBe('idle')
    expect(brushState('end', false)).toBe('handle')
    expect(brushState(null, true)).toBe('drag')
  })
})
