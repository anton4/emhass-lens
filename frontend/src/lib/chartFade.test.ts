import { describe, expect, it } from 'vitest'
import { fadeStops, onFadedSide, scaleAlpha, splitOffset } from './chartFade'

describe('splitOffset', () => {
  it('is the share of the width the split is in', () => {
    expect(splitOffset(150, 100, 200)).toBe(0.25)
  })

  it('stays inside 0–1 when the split is before or after the plot', () => {
    expect(splitOffset(20, 100, 200)).toBe(0)
    expect(splitOffset(900, 100, 200)).toBe(1)
  })

  it('is 0 for a plot with no width', () => {
    expect(splitOffset(50, 0, 0)).toBe(0)
  })
})

describe('fadeStops', () => {
  it('fades the right of the split for "after", with a hard edge', () => {
    expect(fadeStops(0.4, 'after', 0.5)).toEqual([
      [0, 1],
      [0.4, 1],
      [0.4, 0.5],
      [1, 0.5],
    ])
  })

  it('fades the left of the split for "before"', () => {
    expect(fadeStops(0.4, 'before', 0)).toEqual([
      [0, 0],
      [0.4, 0],
      [0.4, 1],
      [1, 1],
    ])
  })
})

describe('onFadedSide', () => {
  it('takes spans that start at or after the split for "after"', () => {
    expect(onFadedSide(100, 200, 100, 'after')).toBe(true)
    expect(onFadedSide(50, 150, 100, 'after')).toBe(false)
  })

  it('takes spans that end at or before the split for "before"', () => {
    expect(onFadedSide(0, 100, 100, 'before')).toBe(true)
    expect(onFadedSide(50, 150, 100, 'before')).toBe(false)
  })
})

describe('scaleAlpha', () => {
  it('turns a hex colour into rgba at the share', () => {
    expect(scaleAlpha('#2a78d6', 0.5)).toBe('rgba(42, 120, 214, 0.5)')
  })

  it('multiplies an alpha that is already there', () => {
    expect(scaleAlpha('rgba(42, 120, 214, 0.4)', 0.5)).toBe('rgba(42, 120, 214, 0.2)')
    expect(scaleAlpha('#2a78d680', 0.5)).toBe('rgba(42, 120, 214, 0.251)')
    expect(scaleAlpha('rgb(1 2 3 / 50%)', 0.5)).toBe('rgba(1, 2, 3, 0.25)')
  })

  it('leaves colours it cannot read as they are', () => {
    expect(scaleAlpha('transparent', 0.5)).toBe('transparent')
  })
})
