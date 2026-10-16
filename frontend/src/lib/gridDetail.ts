// The grid power measured finer than the quarter-hour means: on the Plan page's Power chart it is the grid line itself
// left of now (the popup's Grid row reads it at the pointer, the quarter-hour mean beside it), beside the market's
// commands. Where the backend had to average (a long window), each point brings its bucket's lowest and highest
// reading, and the line is drawn through them, so every 10-second spike still shows. See
// backend/emhass_lens/services/grid_detail.py.

import type { GridDetail } from '../api/types'
import type { ChartOverlay } from './chartRange'

const HOUR_S = 3600
const SLOT_S = 900
/** The backend serves at most the last 48 h. */
export const DETAIL_MAX_S = 48 * HOUR_S
// Enough for every 10-second reading of an 8-hour window, and buckets of a pixel or so for a longer one
const POINTS = [750, 1500, 3000] as const
const MOST_POINTS = 3000

export interface DetailRequest {
  since: string
  /** null: up to now, read again as it goes on. */
  until: string | null
  maxPoints: number
}

const isoAt = (t: number) => new Date(t * 1000).toISOString()

/** What to ask for: the measured part of the window shown (`[from, to]`, unix s), at most its last 48 h, or null when
 *  none of it is past. Unzoomed, the start is rounded to the hour, so the query stays put while the axis moves on; the
 *  point budget follows the share of the chart the measured part takes. */
export function detailRequest(window: [number, number], nowS: number, zoomed: boolean): DetailRequest | null {
  const [from, to] = window
  const live = to >= nowS
  const end = Math.min(to, nowS)
  if (end <= from) return null
  let start = zoomed ? from : Math.floor(from / HOUR_S) * HOUR_S
  const earliest = live ? Math.ceil((nowS - DETAIL_MAX_S) / HOUR_S) * HOUR_S : end - DETAIL_MAX_S
  start = Math.max(start, earliest)
  if (end <= start) return null
  const share = to > from ? (end - start) / (to - from) : 1
  const maxPoints = POINTS.find((p) => p >= share * MOST_POINTS) ?? MOST_POINTS
  return { since: isoAt(start), until: live ? null : isoAt(end), maxPoints }
}

const unix = (iso: string) => Date.parse(iso) / 1000

/** The measured grid line: each point holds until the next one; a point without a value leaves a gap. A bucket's mean
 *  carries its lowest and highest reading, which the chart draws through. */
export function gridOverlay(detail: GridDetail): ChartOverlay {
  const end = unix(detail.end)
  const spans: ChartOverlay['spans'] = []
  detail.points.forEach((p, i) => {
    if (p.w === null) return
    const next = detail.points[i + 1]
    const span = { from: unix(p.t), to: next ? unix(next.t) : end, value: p.w }
    spans.push(p.lo != null && p.hi != null ? { ...span, lo: p.lo, hi: p.hi } : span)
  })
  return { label: 'Grid', color: '--q-grid', width: 1.25, base: 'none', dot: true, spans }
}

/** The time [start, end) the detail has points for (unix s), or null. */
export function detailCover(detail: GridDetail | undefined): [number, number] | null {
  if (!detail || detail.points.length === 0) return null
  return [unix(detail.start), unix(detail.end)]
}

/** The grid's quarter-hour values with the slots the detail covers left out, so its line draws the grid there instead
 *  (`x` are slot starts; slots from `pastEndS` on are the plan). The plan's slot the detail ends in (the one in
 *  progress) is left out too: `planTail` draws it from where the detail ends. */
export function withoutCovered(
  x: number[],
  values: (number | null)[],
  cover: [number, number] | null,
  pastEndS: number,
): (number | null)[] {
  if (!cover) return values
  const tail = tailIndex(x, cover, pastEndS)
  return values.map((v, i) => {
    const t = x[i]
    return i === tail || (t !== undefined && t >= cover[0] && t + SLOT_S <= cover[1]) ? null : v
  })
}

/** The plan's slot the detail ends in, or -1. */
function tailIndex(x: number[], cover: [number, number], pastEndS: number): number {
  return x.findIndex((t) => t >= pastEndS && t < cover[1] && cover[1] < t + SLOT_S)
}

/** The plan's grid line in the slot in progress from where the detail ends (now) to the slot's end, rising there to
 *  the next slot's value, so the slot isn't drawn twice; null when the detail doesn't end in a plan slot. */
export function planTail(
  x: number[],
  values: (number | null)[],
  cover: [number, number] | null,
  pastEndS: number,
): ChartOverlay['spans'] | null {
  if (!cover) return null
  const i = tailIndex(x, cover, pastEndS)
  const t = x[i]
  const value = values[i]
  if (t === undefined || value === null || value === undefined) return null
  const end = x[i + 1] ?? t + SLOT_S
  const next = values[i + 1]
  return [
    { from: cover[1], to: end, value },
    ...(next !== null && next !== undefined ? [{ from: end, to: end, value: next }] : []),
  ]
}

/** How fine the line is, for the Grid chip's title: "measured every 10 s", "measured at each change". */
export function gridDetailNote(stepS: number | null | undefined): string | null {
  if (stepS === undefined) return null
  if (stepS === null) return 'measured at each change'
  return stepS < 60 ? `measured every ${stepS} s` : `measured every ${stepS / 60} min`
}

/** The point the pointer at `time` is in, or null outside the detail. */
function pointAt(detail: GridDetail | undefined, time: number): GridDetail['points'][number] | null {
  if (!detail || detail.points.length === 0) return null
  if (time < unix(detail.start) || time >= unix(detail.end)) return null
  let lo = 0
  let hi = detail.points.length - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (unix(detail.points[mid]!.t) <= time) lo = mid
    else hi = mid - 1
  }
  const point = detail.points[lo]!
  return unix(point.t) > time ? null : point
}

/** The measured grid power at `time`: the bucket's mean (or the value since the last change) the pointer is in; null
 *  outside the detail or where the sensor had no value. */
export function gridAt(detail: GridDetail | undefined, time: number): number | null {
  return pointAt(detail, time)?.w ?? null
}

/** The lowest and highest reading in the bucket the pointer is in, when the point is a mean; null otherwise. */
export function gridRangeAt(detail: GridDetail | undefined, time: number): [number, number] | null {
  const point = pointAt(detail, time)
  return point && point.w !== null && point.lo != null && point.hi != null ? [point.lo, point.hi] : null
}
