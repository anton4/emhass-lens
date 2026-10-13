import { describe, expect, it } from 'vitest'
import { span, tickState, toggled } from './runPick'

describe('toggled', () => {
  it('ticks and unticks without changing the set it was given', () => {
    const before = new Set([1, 2])
    expect([...toggled(before, [3, 2], true)].sort()).toEqual([1, 2, 3])
    expect([...toggled(before, [2, 9], false)]).toEqual([1])
    expect([...before]).toEqual([1, 2])
  })
})

describe('span', () => {
  const shown = [50, 40, 30, 20, 10]
  it('takes the rows between the last click and this one, either way, as shown', () => {
    expect(span(shown, 40, 20)).toEqual([40, 30, 20])
    expect(span(shown, 20, 40)).toEqual([40, 30, 20])
    expect(span(shown, 30, 30)).toEqual([30])
  })
  it('takes just this row without a last click, or when that row is filtered out', () => {
    expect(span(shown, null, 20)).toEqual([20])
    expect(span(shown, 99, 20)).toEqual([20])
  })
})

describe('tickState', () => {
  it('counts only the rows shown', () => {
    expect(tickState([1, 2], new Set())).toBe('none')
    expect(tickState([1, 2], new Set([2, 7]))).toBe('some')
    expect(tickState([1, 2], new Set([1, 2, 7]))).toBe('all')
    expect(tickState([], new Set([7]))).toBe('none')
  })
})
