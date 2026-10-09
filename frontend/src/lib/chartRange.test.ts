import { describe, expect, it } from 'vitest'
import { fitRange, snapWindow } from './chartRange'

describe('fitRange', () => {
  it('hugs the data with a small margin instead of starting at zero', () => {
    const [a, b] = fitRange(10, 20, { pad: 0.1 })
    expect(a).toBeCloseTo(9)
    expect(b).toBeCloseTo(21)
  })

  it('keeps negative to positive power as it is', () => {
    const [a, b] = fitRange(-3000, 5000, { pad: 0.1 })
    expect(a).toBeCloseTo(-3800)
    expect(b).toBeCloseTo(5800)
  })

  it('widens near-flat data to the minimum span around its centre', () => {
    const [a, b] = fitRange(0, 3, { pad: 0, minSpan: 500 })
    expect(a).toBeCloseTo(-248.5)
    expect(b).toBeCloseTo(251.5)
  })

  it('gives flat data room even without a minimum span', () => {
    expect(fitRange(50, 50, { pad: 0.1 })).toEqual([45, 55])
    expect(fitRange(0, 0, { pad: 0.1 })).toEqual([-1, 1])
  })

  it('shifts the window inside the limits before cutting it', () => {
    // SOC 98–100 % with a 5 % minimum: 95–100, not 96.5–100
    expect(fitRange(98, 100, { pad: 0, minSpan: 5, clamp: [0, 100] })).toEqual([95, 100])
    expect(fitRange(0, 1, { pad: 0, minSpan: 5, clamp: [0, 100] })).toEqual([0, 5])
    // wider than the limits: cut to them
    expect(fitRange(-10, 120, { pad: 0, clamp: [0, 100] })).toEqual([0, 100])
  })

  it('falls back to the limits (or 0–1) without data', () => {
    expect(fitRange(null, null, { clamp: [0, 100] })).toEqual([0, 100])
    expect(fitRange(undefined, undefined)).toEqual([0, 1])
  })
})

describe('snapWindow', () => {
  it('rounds a dragged window to whole slots, at least one wide', () => {
    expect(snapWindow([1_000_000_000 - 60, 1_000_000_000 + 21_540], 900)).toEqual([999_999_900, 1_000_021_500])
    expect(snapWindow([1800, 1810], 900)).toEqual([1800, 2700])
    expect(snapWindow([2700, 900], 900)).toEqual([900, 2700])
  })
})
