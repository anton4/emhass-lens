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
  /** The value at the pointer's own moment (the grid measured finer than the slots), or null: shown instead of the
   *  slot's, which gets a row of its own under it. */
  moment?: (time: number) => number | null
  /** The lowest and highest reading behind the moment's value (a long window's bucket), or null: a row of its own. */
  momentRange?: (time: number) => [number, number] | null
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
  /** The popup's first row, wherever the line is drawn (the grid, drawn on top of the Power chart's areas). */
  lead?: boolean
  /** The row also gives its share of the total ("41 %"). */
  share?: boolean
  /** Where the row goes among the others: lower first; rows without one keep their order, before ranked ones. */
  popupRank?: number
  /** The row sits under a rule. */
  rule?: boolean
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
  /** The quarter-hour's own value when the row shows the pointer's moment ("+5.90 kW"); null otherwise. */
  slot: string | null
  /** The lowest and highest reading behind the moment's value ("−12.90 kW … 480 W"); null otherwise. */
  range: string | null
  /** The plan at the time, formatted; null when there is none. */
  then: string | null
  /** Its share of the total ("41 %"), or null. */
  share: string | null
  /** Under a rule. */
  rule: boolean
}

const known = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v)

/** One row per series at `idx` (its "planned at the time" partner folded into it); series with nothing there are left
 *  out. A series with a value at the pointer's moment `time` shows that, with the slot's value (and the readings'
 *  range) beside it for the popup to put on rows of their own. Rows that ask for it give their share of the total.
 *  With `totalInHead` the total comes back on its own instead of as the last row. */
export function popupRows(
  series: PopupSeries[],
  idx: number,
  time?: number,
  opts: { totalInHead?: boolean } = {},
): { rows: PopupRow[]; hasThen: boolean; total: PopupRow | null } {
  const rows: PopupRow[] = []
  const totalSeries = series.find((s) => s.total)
  const totalValue = totalSeries ? (totalSeries.readout ?? totalSeries.values)[idx] : null
  series.forEach((s, i) => {
    if (s.then || s.helper) return
    const partner = series[i + 1]?.then ? series[i + 1] : undefined
    const slot = (s.readout ?? s.values)[idx]
    const moment = time !== undefined ? s.moment?.(time) : null
    const range = known(moment) && time !== undefined ? (s.momentRange?.(time) ?? null) : null
    const value = known(moment) ? moment : slot
    const then = partner?.values[idx]
    if (!known(value) && !known(then)) return
    const format = (v: number, by: PopupSeries) => (by.format ? by.format(v) : String(v))
    const share =
      s.share && known(value) && known(totalValue) && totalValue > 0
        ? `${Math.round((value / totalValue) * 100)} %`
        : null
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
      slot: known(moment) && known(slot) ? format(slot, s) : null,
      range: range ? `${format(range[0], s)} … ${format(range[1], s)}` : null,
      then: known(then) && partner ? format(then, partner) : null,
      share,
      rule: Boolean(s.rule),
    })
  })
  const order = (r: PopupRow) => {
    const s = series[r.series]
    return s?.lead ? -Infinity : (s?.popupRank ?? 0)
  }
  rows.sort((a, b) => order(a) - order(b))
  const total = opts.totalInHead ? (rows.find((r) => r.total) ?? null) : null
  const shown = total ? rows.filter((r) => r !== total) : rows
  return { rows: shown, hasThen: shown.some((r) => r.then !== null), total }
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

const rangeFormats = new Map<
  string,
  { start: Intl.DateTimeFormat; end: Intl.DateTimeFormat; moment: Intl.DateTimeFormat }
>()

function formats(timeZone?: string) {
  const key = timeZone ?? ''
  let fmt = rangeFormats.get(key)
  if (!fmt) {
    const clock = { timeZone, hour: '2-digit', minute: '2-digit', hour12: false } as const
    fmt = {
      start: new Intl.DateTimeFormat('en-GB', { ...clock, weekday: 'short' }),
      end: new Intl.DateTimeFormat('en-GB', clock),
      moment: new Intl.DateTimeFormat('en-GB', { ...clock, weekday: 'short', second: '2-digit' }),
    }
    rangeFormats.set(key, fmt)
  }
  return fmt
}

/** A slot as "Mon 10:45–11:00" in `timeZone` (unix seconds), or "10:45–11:00" without the weekday. */
export function slotRange(start: number, end: number, timeZone?: string, weekday = true): string {
  const fmt = formats(timeZone)
  return `${(weekday ? fmt.start : fmt.end).format(new Date(start * 1000))}–${fmt.end.format(new Date(end * 1000))}`
}

/** A moment to the second as "Mon 10:52:14" in `timeZone` (unix seconds). */
export function momentLabel(t: number, timeZone?: string): string {
  return formats(timeZone).moment.format(new Date(Math.floor(t) * 1000))
}

/** The popup's rows as one line for a screen reader: "Fri 13:25:20: Grid −2.55 kW, exporting; PV 4.75 kW". */
export function readoutText(head: string, rows: Pick<PopupRow, 'name' | 'value' | 'describe' | 'then'>[]): string {
  const parts = rows.map((r) => {
    let text = `${r.name} ${r.value}`
    if (r.describe) text += `, ${r.describe}`
    if (r.then) text += `, planned then ${r.then}`
    return text
  })
  return parts.length > 0 ? `${head}: ${parts.join('; ')}` : head
}
