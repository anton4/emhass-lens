// Y-axis ranges that hug the data: min–max plus a small margin, without forcing zero into view.

export interface FitOptions {
  /** Margin above and below, as a share of the data's span. */
  pad?: number
  /** Narrowest span to show, so near-flat data isn't blown up into noise (in the axis unit). */
  minSpan?: number
  /** Limits the axis never goes past (e.g. 0–100 for a percentage); null = open. */
  clamp?: [number | null, number | null]
  /** Keep zero in view (a stacked chart that fills from zero). */
  zero?: boolean
}

/** A line drawn at times of its own rather than on the chart's slot grid: a market command from its start to its
 *  end, or the grid power measured finer than the slots. */
export interface ChartOverlay {
  label: string
  /** CSS custom property or colour. */
  color: string
  width?: number
  dash?: number[]
  /** Fill between the line and zero at this opacity. */
  fill?: number
  /** 'zero' (default): each run rises from zero and returns to it; 'none': it starts and ends at its own values. */
  base?: 'zero' | 'none'
  /** A ring in the surface colour under the line, so it stands clear of the lines it crosses. */
  halo?: boolean
  /** false: the y-axis doesn't fit it (a market command far past the measured lines). Beyond the axis it runs along
   *  the edge it leaves through, with `offScale`'s text at its start. */
  fit?: false
  /** The text for a span beyond the axis ("↓ 15.5 kW"). */
  offScale?: (value: number) => string
  /** `lo` and `hi`: the lowest and highest reading behind a span's mean; the line is drawn through them. */
  spans: { from: number; to: number; value: number; lo?: number; hi?: number }[]
  /** Drawn at this share of its opacity on the chart's split side (the plan right of now). */
  fade?: number
  /** A dot on the line at the cursor, as the chart's series have. */
  dot?: boolean
}

/** The area between two values over stretches of time, hatched in a colour: where the grid delivered less than a
 *  market command asked. */
export interface ChartGap {
  /** CSS custom property or colour. */
  color: string
  spans: { from: number; to: number; a: number; b: number }[]
  /** Drawn at this share of its opacity on the chart's split side. */
  fade?: number
}

/** The overlay's lines as [time, value] points: each run of back-to-back spans (less than a second apart) steps
 *  through their values; a gap between spans breaks the line. */
export function overlayRuns(spans: ChartOverlay['spans'], base: 'zero' | 'none' = 'zero'): [number, number][][] {
  const sorted = [...spans].sort((a, b) => a.from - b.from)
  const runs: [number, number][][] = []
  let run: [number, number][] = []
  let end = 0
  for (const span of sorted) {
    if (run.length > 0 && Math.abs(end - span.from) >= 1) {
      if (base === 'zero') run.push([end, 0])
      runs.push(run)
      run = []
    }
    if (run.length === 0 && base === 'zero') run.push([span.from, 0])
    run.push([span.from, span.value], [span.to, span.value])
    end = span.to
  }
  if (run.length > 0) {
    if (base === 'zero') run.push([end, 0])
    runs.push(run)
  }
  return runs
}

// each overlay's spans sorted by start, once per spans array
const byStart = new WeakMap<ChartOverlay['spans'], ChartOverlay['spans']>()

/** The overlay's value at `t` (unix s): the span it is in, or null in a gap or outside them. */
export function overlayAt(overlay: Pick<ChartOverlay, 'spans'>, t: number): number | null {
  let spans = byStart.get(overlay.spans)
  if (!spans) {
    spans = [...overlay.spans].sort((a, b) => a.from - b.from)
    byStart.set(overlay.spans, spans)
  }
  let lo = 0
  let hi = spans.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (spans[mid]!.from <= t) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  const span = spans[found]
  return span && t < span.to ? span.value : null
}

/** The lowest and highest overlay value with a span in [from, to] (unix seconds; open ends when null), or null.
 *  Overlays with `fit: false` don't count. */
export function overlayExtent(
  overlays: ChartOverlay[],
  from: number | null | undefined,
  to: number | null | undefined,
): [number, number] | null {
  let lo = Infinity
  let hi = -Infinity
  for (const overlay of overlays) {
    if (overlay.fit === false) continue
    for (const span of overlay.spans) {
      if ((to !== null && to !== undefined && span.from > to) || (from !== null && from !== undefined && span.to < from)) {
        continue
      }
      lo = Math.min(lo, span.lo ?? span.value)
      hi = Math.max(hi, span.hi ?? span.value)
    }
  }
  return lo <= hi ? [lo, hi] : null
}

export function fitRange(
  min: number | null | undefined,
  max: number | null | undefined,
  { pad = 0.08, minSpan = 0, clamp, zero = false }: FitOptions = {},
): [number, number] {
  const lo = clamp?.[0] ?? null
  const hi = clamp?.[1] ?? null
  if (min === null || min === undefined || max === null || max === undefined) return [lo ?? 0, hi ?? 1]

  let a = zero ? Math.min(min, 0) : min
  let b = zero ? Math.max(max, 0) : max
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
/** The narrowest window a zoom goes to, in seconds: still a few dozen 10-second readings. */
export const MIN_WINDOW_S = 600

/** `window` moved inside `bounds` (unix seconds) without changing its width, or narrowed to them when wider. */
export function clampWindow([a, b]: [number, number], [lo, hi]: [number, number]): [number, number] {
  const span = Math.min(b - a, hi - lo)
  const start = Math.max(lo, Math.min(a, hi - span))
  return [start, start + span]
}

/** `window` zoomed by `factor` (below 1 zooms in) around the time `at` (kept inside the window), at least MIN_WINDOW_S
 *  wide and inside `bounds`. */
export function zoomAround(
  [a, b]: [number, number],
  at: number,
  factor: number,
  bounds: [number, number],
): [number, number] {
  const pivot = Math.min(Math.max(at, a), b)
  let start = pivot - (pivot - a) * factor
  let end = pivot + (b - pivot) * factor
  if (end - start < MIN_WINDOW_S) {
    const mid = (start + end) / 2
    start = mid - MIN_WINDOW_S / 2
    end = mid + MIN_WINDOW_S / 2
  }
  return clampWindow([start, end], bounds)
}

/** `window` moved by `dt` seconds, kept inside `bounds`. */
export function panBy([a, b]: [number, number], dt: number, bounds: [number, number]): [number, number] {
  return clampWindow([a + dt, b + dt], bounds)
}

/** Where a wheel turn takes the window shown: an up/down turn zooms around the pointer's time `at` (at most by half
 *  per event); a sideways turn, or any turn with `pan` (Shift held), moves the window by the turn's share of the plot
 *  `width`. Kept inside `bounds` and at least MIN_WINDOW_S wide; null when it doesn't move. */
export function wheelWindow(
  shown: [number, number],
  bounds: [number, number],
  o: { at: number; dx: number; dy: number; pan: boolean; width: number },
): [number, number] | null {
  const [a, b] = shown
  const span = b - a
  let { dx, dy } = o
  if (o.pan && dx === 0) {
    dx = dy
    dy = 0
  }
  let out: [number, number]
  if (Math.abs(dx) > Math.abs(dy)) out = panBy(shown, (dx / Math.max(1, o.width)) * span, bounds)
  else {
    if (dy === 0) return null
    out = zoomAround(shown, o.at, Math.exp(Math.max(-0.5, Math.min(0.5, dy * 0.0025))), bounds)
  }
  return Math.abs(out[0] - a) < 0.5 && Math.abs(out[1] - b) < 0.5 ? null : out
}

/** What a press on the overview's brush grabs at `px` (the brush spans x0–x1 px): an edge within `grip` px, the brush
 *  itself, or nothing (the press is outside it). */
export function brushGrab(px: number, x0: number, x1: number, grip = 9): 'start' | 'end' | 'move' | null {
  if (Math.abs(px - x0) <= grip && px <= (x0 + x1) / 2) return 'start'
  if (Math.abs(px - x1) <= grip) return 'end'
  if (px > x0 && px < x1) return 'move'
  return null
}

/** The window after dragging what was grabbed from time `grabT` to `t` (unix s): the brush moves whole, or one edge
 *  moves and the window stays at least MIN_WINDOW_S wide; always inside `bounds`. */
export function brushWindow(
  grabbed: 'start' | 'end' | 'move',
  from: [number, number],
  grabT: number,
  t: number,
  bounds: [number, number],
): [number, number] {
  const [a, b] = from
  if (grabbed === 'move') return clampWindow([a + t - grabT, b + t - grabT], bounds)
  if (grabbed === 'start') return [Math.max(bounds[0], Math.min(t, b - MIN_WINDOW_S)), b]
  return [a, Math.min(bounds[1], Math.max(t, a + MIN_WINDOW_S))]
}

export function snapWindow([a, b]: [number, number], step: number): [number, number] {
  const start = Math.round(Math.min(a, b) / step) * step
  const end = Math.round(Math.max(a, b) / step) * step
  return [start, Math.max(end, start + step)]
}
