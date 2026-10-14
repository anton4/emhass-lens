// The grid power measured finer than the quarter-hour means, on the Plan page's Power chart beside the market's
// commands. See backend/emhass_lens/services/grid_detail.py.

import type { GridDetail } from '../api/types'
import type { PopupExtra } from '../components/charts/cursorStore'
import type { ChartOverlay } from './chartRange'
import { formatClock } from './format'
import { formatSignedPower } from './units'

const HOUR_S = 3600
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

/** The measured line over the Power chart: each point holds until the next one; a point without a value leaves a
 *  gap. */
export function gridOverlay(detail: GridDetail): ChartOverlay {
  const end = unix(detail.end)
  const spans: ChartOverlay['spans'] = []
  detail.points.forEach((p, i) => {
    if (p.w === null) return
    const next = detail.points[i + 1]
    spans.push({ from: unix(p.t), to: next ? unix(next.t) : end, value: p.w })
  })
  return { label: 'Grid measured', color: '--q-grid', width: 1.25, base: 'none', spans }
}

/** The chip's name: how fine the line is. */
export function gridDetailLabel(stepS: number | null | undefined): string {
  if (stepS === undefined) return 'Grid in detail'
  if (stepS === null) return 'Grid, each change'
  return stepS < 60 ? `Grid every ${stepS} s` : `Grid every ${stepS / 60} min`
}

/** The popup's row for the measured grid power at the pointer: "−9.31 kW at 08:52:31", or the bucket's mean with
 *  its times when the line is means; none where the sensor had no value. */
export function gridRows(detail: GridDetail | undefined, time: number, timeZone?: string): PopupExtra[] {
  if (!detail || detail.points.length === 0) return []
  const end = unix(detail.end)
  if (time < unix(detail.start) || time >= end) return []
  let lo = 0
  let hi = detail.points.length - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (unix(detail.points[mid]!.t) <= time) lo = mid
    else hi = mid - 1
  }
  const point = detail.points[lo]!
  if (point.w === null || unix(point.t) > time) return []
  const next = detail.points[lo + 1]
  const when =
    detail.step_s === null
      ? `at ${formatClock(isoAt(time), timeZone)}`
      : `· ${formatClock(point.t, timeZone)}–${formatClock(next ? next.t : detail.end, timeZone)}`
  return [{ name: 'Grid measured', value: `${formatSignedPower(point.w)} ${when}`, color: '--q-grid' }]
}
