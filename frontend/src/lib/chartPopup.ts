// The value popup on the Plan page's charts: which rows it lists at the cursor, which one the pointer is nearest, and
// where the popup sits beside the cursor.

export interface PopupSeries {
  label: string
  /** A shorter name for the popup ("Battery" for "Battery (+ charge)"). */
  popupLabel?: string
  color: string
  dash?: number[]
  /** The plan at the time for the series just before this one: its value goes in that row's "planned then" column. */
  then?: boolean
  values: (number | null)[]
  /** What the popup shows when the drawn values are stacked sums. */
  readout?: (number | null)[]
  format?: (value: number) => string
  /** A word for the value's direction ("charging"). */
  describe?: (value: number) => string
  /** Only the edge another series fills down to: no row. */
  helper?: boolean
  /** A part switched off: its row is faded. */
  muted?: boolean
  /** The total, last under a rule. */
  total?: boolean
  /** Drawn as an area: a square swatch. */
  area?: boolean
}

export interface PopupRow {
  /** Index of the row's series. */
  series: number
  name: string
  color: string
  dashed: boolean
  area: boolean
  muted: boolean
  total: boolean
  value: string
  describe: string
  /** The plan at the time, formatted; null when there is none. */
  then: string | null
}

const known = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v)

/** One row per series at `idx` (its "planned at the time" partner folded into it); series with nothing there are left out. */
export function popupRows(series: PopupSeries[], idx: number): { rows: PopupRow[]; hasThen: boolean } {
  const rows: PopupRow[] = []
  series.forEach((s, i) => {
    if (s.then || s.helper) return
    const partner = series[i + 1]?.then ? series[i + 1] : undefined
    const value = (s.readout ?? s.values)[idx]
    const then = partner?.values[idx]
    if (!known(value) && !known(then)) return
    const format = (v: number, by: PopupSeries) => (by.format ? by.format(v) : String(v))
    rows.push({
      series: i,
      name: s.popupLabel ?? s.label,
      color: s.color,
      dashed: Boolean(s.dash?.length),
      area: Boolean(s.area),
      muted: Boolean(s.muted),
      total: Boolean(s.total),
      value: known(value) ? format(value, s) : '—',
      describe: known(value) && s.describe ? s.describe(value) : '',
      then: known(then) && partner ? format(then, partner) : null,
    })
  })
  return { rows, hasThen: rows.some((r) => r.then !== null) }
}

/** The series whose value is drawn nearest the pointer's height, or null when there is none. */
export function nearestRow(points: { series: number; y: number }[], pointerY: number): number | null {
  let best: number | null = null
  let distance = Infinity
  for (const p of points) {
    const d = Math.abs(p.y - pointerY)
    if (d < distance) {
      distance = d
      best = p.series
    }
  }
  return best
}

/** Where the popup's box goes in the plot: `gap` px beside the cursor (to its left, `flip`, past `flipAt` of the
 *  width), centred on the anchor's height but kept inside the plot; a popup taller than the plot overhangs both ends
 *  equally. `left` is the edge next to the cursor: the box's right edge when flipped. */
export function placePopup(o: {
  left: number
  anchorY: number
  width: number
  height: number
  popupHeight: number
  gap?: number
  flipAt?: number
}): { left: number; top: number; flip: boolean } {
  const gap = o.gap ?? 14
  const flip = o.left > o.width * (o.flipAt ?? 0.58)
  const top =
    o.popupHeight >= o.height
      ? (o.height - o.popupHeight) / 2
      : Math.min(Math.max(o.anchorY - o.popupHeight / 2, 0), o.height - o.popupHeight)
  return { left: flip ? o.left - gap : o.left + gap, top, flip }
}

const rangeFormats = new Map<string, { start: Intl.DateTimeFormat; end: Intl.DateTimeFormat }>()

/** A slot as "Mon 10:45–11:00" in `timeZone` (unix seconds). */
export function slotRange(start: number, end: number, timeZone?: string): string {
  const key = timeZone ?? ''
  let fmt = rangeFormats.get(key)
  if (!fmt) {
    fmt = {
      start: new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }),
      end: new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }),
    }
    rangeFormats.set(key, fmt)
  }
  return `${fmt.start.format(new Date(start * 1000))}–${fmt.end.format(new Date(end * 1000))}`
}
