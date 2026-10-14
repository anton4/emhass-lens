// The grid power measured finer than the quarter-hour means: on the Plan page's Power chart it is the grid line itself
// left of now (the quarter-hour means stay in the popup), beside the market's commands. See
// backend/emhass_lens/services/grid_detail.py.

import type { GridDetail } from '../api/types'
import type { PopupExtra } from '../components/charts/cursorStore'
import type { ChartOverlay } from './chartRange'
import { formatSignedPower } from './units'

const HOUR_S = 3600
const SLOT_S = 900
/** The backend serves at most the last 48 h. */
export const DETAIL_MAX_S = 48 * HOUR_S
const POINTS = [250, 500, 1000] as const
const MOST_POINTS = 1500

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

/** The measured grid line: each point holds until the next one; a point without a value leaves a gap. */
export function gridOverlay(detail: GridDetail): ChartOverlay {
  const end = unix(detail.end)
  const spans: ChartOverlay['spans'] = []
  detail.points.forEach((p, i) => {
    if (p.w === null) return
    const next = detail.points[i + 1]
    spans.push({ from: unix(p.t), to: next ? unix(next.t) : end, value: p.w })
  })
  return { label: 'Grid', color: '--q-grid', width: 1.5, base: 'none', spans }
}

/** The time [start, end) the detail has points for (unix s), or null. */
export function detailCover(detail: GridDetail | undefined): [number, number] | null {
  if (!detail || detail.points.length === 0) return null
  return [unix(detail.start), unix(detail.end)]
}

/** The grid's quarter-hour values with the measured slots the detail covers left out, so its line draws the grid
 *  there instead (`x` are slot starts; slots from `pastEndS` on are the plan and stay). */
export function withoutCovered(
  x: number[],
  values: (number | null)[],
  cover: [number, number] | null,
  pastEndS: number,
): (number | null)[] {
  if (!cover) return values
  return values.map((v, i) => {
    const t = x[i]
    return t !== undefined && t < pastEndS && t >= cover[0] && t + SLOT_S <= cover[1] ? null : v
  })
}

/** How fine the line is, for the Grid chip's title: "measured every 10 s", "measured at each change". */
export function gridDetailNote(stepS: number | null | undefined): string | null {
  if (stepS === undefined) return null
  if (stepS === null) return 'measured at each change'
  return stepS < 60 ? `measured every ${stepS} s` : `measured every ${stepS / 60} min`
}

/** The measured grid power at `time`: the bucket's mean (or the value since the last change) the pointer is in; null
 *  outside the detail or where the sensor had no value. */
export function gridAt(detail: GridDetail | undefined, time: number): number | null {
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
  return point.w === null || unix(point.t) > time ? null : point.w
}

/** The popup's row for the measured grid power at the pointer ("−9.31 kW"; the popup's header has the time). */
export function gridRows(detail: GridDetail | undefined, time: number): PopupExtra[] {
  const w = gridAt(detail, time)
  return w === null ? [] : [{ name: 'Grid measured', value: formatSignedPower(w), color: '--q-grid' }]
}
