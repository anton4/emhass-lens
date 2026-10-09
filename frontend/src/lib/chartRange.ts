// Y-axis ranges that hug the data: min–max plus a small margin, without forcing zero into view.

export interface FitOptions {
  /** Margin above and below, as a share of the data's span. */
  pad?: number
  /** Narrowest span to show, so near-flat data isn't blown up into noise (in the axis unit). */
  minSpan?: number
  /** Limits the axis never goes past (e.g. 0–100 for a percentage); null = open. */
  clamp?: [number | null, number | null]
}

export function fitRange(
  min: number | null | undefined,
  max: number | null | undefined,
  { pad = 0.08, minSpan = 0, clamp }: FitOptions = {},
): [number, number] {
  const lo = clamp?.[0] ?? null
  const hi = clamp?.[1] ?? null
  if (min === null || min === undefined || max === null || max === undefined) return [lo ?? 0, hi ?? 1]

  let a = min
  let b = max
  if (b - a < minSpan) {
    const centre = (a + b) / 2
    a = centre - minSpan / 2
    b = centre + minSpan / 2
  }
  const span = b - a
  const margin = span > 0 ? span * pad : Math.abs(a) * 0.1 || 1 // flat data with no minSpan: still give it room
  a -= margin
  b += margin

  // Keep the window's size where possible by shifting it inside the limits, then cut what still sticks out.
  if (lo !== null && a < lo) {
    b += lo - a
    a = lo
  }
  if (hi !== null && b > hi) {
    a -= b - hi
    b = hi
  }
  if (lo !== null && a < lo) a = lo
  return [a, b]
}

/** A zoom window rounded to whole steps (e.g. 900 s slots), at least one step wide. */
export function snapWindow([a, b]: [number, number], step: number): [number, number] {
  const start = Math.round(Math.min(a, b) / step) * step
  const end = Math.round(Math.max(a, b) / step) * step
  return [start, Math.max(end, start + step)]
}
