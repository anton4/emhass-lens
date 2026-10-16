import { describe, expect, it } from 'vitest'
import {
  brushGrab,
  brushWindow,
  clampWindow,
  dragPan,
  fitRange,
  MIN_WINDOW_S,
  overlayAt,
  overlayExtent,
  overlayRuns,
  pinchWindow,
  snapWindow,
  wheelWindow,
} from './chartRange'

describe('fitRange', () => {
  it('hugs the data with a small margin instead of starting at zero', () => {
    const [a, b] = fitRange(10, 20, { pad: 0.1 })
    expect(a).toBeCloseTo(9)
    expect(b).toBeCloseTo(21)
  })

  it('keeps zero in view for a stacked chart', () => {
    const [a, b] = fitRange(10, 20, { pad: 0.1, zero: true })
    expect(a).toBeCloseTo(-2)
    expect(b).toBeCloseTo(22)
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

describe('overlayRuns', () => {
  const spans = [
    { from: 30, to: 40, value: -5 },
    { from: 0, to: 10, value: 2 },
    { from: 10.5, to: 20, value: 3 }, // under a second after the first: joined
  ]

  it('takes a command from zero through its values and back', () => {
    expect(overlayRuns(spans)).toEqual([
      [[0, 0], [0, 2], [10, 2], [10.5, 3], [20, 3], [20, 0]],
      [[30, 0], [30, -5], [40, -5], [40, 0]],
    ])
  })

  it('starts and ends a measurement at its own values, a gap breaking the line', () => {
    expect(overlayRuns(spans, 'none')).toEqual([
      [[0, 2], [10, 2], [10.5, 3], [20, 3]],
      [[30, -5], [40, -5]],
    ])
    expect(overlayRuns([], 'none')).toEqual([])
  })

  it('counts every overlay in the window towards the y-axis', () => {
    const overlay = { label: 'x', color: 'red', spans }
    expect(overlayExtent([overlay], 25, 50)).toEqual([-5, -5])
    expect(overlayExtent([overlay], null, null)).toEqual([-5, 3])
  })

  it("leaves out an overlay the axis doesn't fit (a command far past the measured lines)", () => {
    const measured = { label: 'Grid', color: 'red', spans: [{ from: 0, to: 10, value: 7600 }] }
    const commanded = { label: 'Commanded', color: 'black', fit: false as const, spans: [{ from: 0, to: 10, value: 15500 }] }
    expect(overlayExtent([commanded, measured], null, null)).toEqual([7600, 7600])
    expect(overlayExtent([commanded], null, null)).toBeNull()
  })
})

describe('wheelWindow', () => {
  const bounds: [number, number] = [0, 100_000]
  const base = { dx: 0, pan: false, width: 1000 }

  it('zooms in and out around the pointer, keeping its time where it was', () => {
    const shown: [number, number] = [10_000, 20_000]
    const zoomedIn = wheelWindow(shown, bounds, { ...base, at: 12_000, dy: -100 })!
    expect(zoomedIn[1] - zoomedIn[0]).toBeLessThan(10_000)
    // the pointer's time stays at the same share of the window
    expect((12_000 - zoomedIn[0]) / (zoomedIn[1] - zoomedIn[0])).toBeCloseTo(0.2)
    const zoomedOut = wheelWindow(shown, bounds, { ...base, at: 12_000, dy: 100 })!
    expect(zoomedOut[1] - zoomedOut[0]).toBeGreaterThan(10_000)
  })

  it('pans with a sideways turn or Shift, by the turn’s share of the plot', () => {
    expect(wheelWindow([10_000, 20_000], bounds, { ...base, at: 0, dx: 100, dy: 0 })).toEqual([11_000, 21_000])
    expect(wheelWindow([10_000, 20_000], bounds, { ...base, at: 0, dy: -100, pan: true })).toEqual([9_000, 19_000])
  })

  it('stays inside the bounds, no narrower than ten minutes, and says when nothing moves', () => {
    expect(wheelWindow([0, 10_000], bounds, { ...base, at: 0, dx: -500, dy: 0 })).toBeNull()
    expect(wheelWindow([95_000, 100_000], bounds, { ...base, at: 0, dx: 400, dy: 0 })).toBeNull()
    const narrow = wheelWindow([1_000, 1_700], bounds, { ...base, at: 1_350, dy: -500 })!
    expect(narrow[1] - narrow[0]).toBe(MIN_WINDOW_S)
    expect(clampWindow([-50, 150], [0, 100])).toEqual([0, 100])
    expect(clampWindow([90, 120], [0, 100])).toEqual([70, 100])
  })
})

describe('the overview brush', () => {
  it('grabs an edge, the brush or nothing', () => {
    expect(brushGrab(102, 100, 300)).toBe('start')
    expect(brushGrab(295, 100, 300)).toBe('end')
    expect(brushGrab(200, 100, 300)).toBe('move')
    expect(brushGrab(50, 100, 300)).toBeNull()
  })

  it('moves the window whole or by one edge, inside the data and never too narrow', () => {
    const bounds: [number, number] = [0, 100_000]
    expect(brushWindow('move', [10_000, 20_000], 15_000, 18_000, bounds)).toEqual([13_000, 23_000])
    expect(brushWindow('move', [10_000, 20_000], 15_000, 110_000, bounds)).toEqual([90_000, 100_000])
    expect(brushWindow('start', [10_000, 20_000], 10_000, 4_000, bounds)).toEqual([4_000, 20_000])
    expect(brushWindow('start', [10_000, 20_000], 10_000, 19_900, bounds)).toEqual([20_000 - MIN_WINDOW_S, 20_000])
    expect(brushWindow('end', [10_000, 20_000], 20_000, 200_000, bounds)).toEqual([10_000, 100_000])
  })
})

describe('overlayAt', () => {
  const overlay = {
    spans: [
      { from: 200, to: 300, value: 5 },
      { from: 100, to: 200, value: 3 },
      { from: 400, to: 500, value: 7 },
    ],
  }

  it('is the value of the span the time is in, whatever order the spans come in', () => {
    expect(overlayAt(overlay, 150)).toBe(3)
    expect(overlayAt(overlay, 250)).toBe(5)
  })

  it('takes a span from its start, not at its end', () => {
    expect(overlayAt(overlay, 200)).toBe(5)
    expect(overlayAt(overlay, 500)).toBeNull()
  })

  it('is null in a gap and outside the spans', () => {
    expect(overlayAt(overlay, 350)).toBeNull()
    expect(overlayAt(overlay, 50)).toBeNull()
    expect(overlayAt({ spans: [] }, 50)).toBeNull()
  })
})

describe('dragPan', () => {
  it('keeps the time under the pointer: a drag to the right shows earlier times', () => {
    expect(dragPan([3600, 7200], 100, 1000, [0, 36000])).toEqual([3240, 6840])
  })

  it('stays inside the bounds', () => {
    expect(dragPan([0, 3600], 500, 1000, [0, 36000])).toEqual([0, 3600])
  })
})

describe('pinchWindow', () => {
  const start = { window: [3600, 7200] as [number, number], a: 400, b: 600 }

  it('zooms in when the fingers spread, around their midpoint', () => {
    const out = pinchWindow(start, { a: 300, b: 700 }, 1000, [0, 36000])
    expect(out[1] - out[0]).toBeCloseTo(1800)
    expect((out[0] + out[1]) / 2).toBeCloseTo(5400)
  })

  it('pans when the fingers move together', () => {
    expect(pinchWindow(start, { a: 500, b: 700 }, 1000, [0, 36000])).toEqual([3240, 6840])
  })

  it('never goes below the narrowest window or past the bounds', () => {
    const out = pinchWindow(start, { a: 0, b: 1000 }, 1000, [0, 36000])
    expect(out[1] - out[0]).toBeGreaterThanOrEqual(MIN_WINDOW_S)
    expect(pinchWindow(start, { a: 495, b: 505 }, 1000, [0, 7200])).toEqual([0, 7200])
  })
})

describe('spans that run from one value to another', () => {
  const sloped = { spans: [{ from: 0, to: 100, value: 10, toValue: 50 }] }

  it('draws straight from the start value to the end value', () => {
    expect(overlayRuns(sloped.spans, 'none')).toEqual([
      [
        [0, 10],
        [100, 50],
      ],
    ])
  })

  it('counts both ends for the axis', () => {
    expect(overlayExtent([{ label: '', color: '', ...sloped }], null, null)).toEqual([10, 50])
  })

  it('reads the value along the way', () => {
    expect(overlayAt(sloped, 25)).toBe(20)
  })
})
