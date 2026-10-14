// A time-series chart on uPlot: step lines per 15-minute slot (or stacked columns, one per slot), a synced crosshair
// across charts, shaded ranges (forecast), hairlines (midnights) and a "now" marker. The live legend under the
// plot is the readout: it lists every series' value at the crosshair; with `popup` a popup beside the
// cursor shows them instead and the legend is a plain key. Optionally the y-axis hugs the visible
// data (fit) and a drag selects a time range to zoom into (onZoom / xRange).

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { columnGap, columnSegment, inRanges, slotIndex } from '../../lib/chartColumns'
import { fitRange, overlayExtent, overlayRuns, type ChartOverlay, type FitOptions } from '../../lib/chartRange'
import { ChartPopup } from './ChartPopup'
import { createCursorStore, type CursorAt, type PopupExtra, type PopupTag } from './cursorStore'
import { cssColor, cssValue, useThemeVersion, withAlpha } from './useTheme'

export interface ChartSeries {
  label: string
  values: (number | null)[]
  /** CSS custom property ("--q-batt") or colour. */
  color: string
  width?: number
  dash?: number[]
  /** Fill the area between the line and zero at this opacity (PV is drawn as an area). */
  fill?: number
  /** Step line (value holds until the next point). Default true. */
  step?: boolean
  /** Readout format for the legend and the popup. */
  format?: (value: number) => string
  /** The plan at the time for the series just before this one: the popup shows it in that row, the key leaves it out. */
  then?: boolean
  /** A shorter name for the popup ("Battery" for "Battery (+ charge)"). */
  popupLabel?: string
  /** A word for the value's direction in the popup ("charging"). */
  describe?: (value: number) => string
  /** Fill down to series `below` (its index) instead of to zero: a stacked area, solid unless `fill` says otherwise. */
  below?: number
  /** What the popup shows when `values` are stacked sums. */
  readout?: (number | null)[]
  /** Only the edge another series fills down to: no line, no popup row, no cursor dot. */
  helper?: boolean
  /** A part switched off: faded in the popup, no cursor dot. */
  muted?: boolean
  /** The popup's last row, under a rule. */
  total?: boolean
  /** A column per slot instead of a line: 'stack' fills from the series `below` (or zero) to the value, a hairline
   *  apart from the part it sits on; 'cap' is a short bar at the value across the column (none at `width` 0). Columns
   *  in a shaded range (a forecast) are faded. */
  column?: 'stack' | 'cap'
}

// how strongly columns in a shaded range (a forecast) are drawn
const FADED = 0.55

/** A mark at one moment, drawn as a short bar (MPC runs on the plan's time axis). */
export interface ChartTick {
  t: number
  /** CSS custom property or colour. */
  color: string
  /** Shown as the tooltip when the pointer is near it. */
  label: string
  /** What the tick stands for (a run id), for onTick. */
  id?: number
}

/** A row of spans between the plot and the time axis (tariff periods, export limits, a load's window), labelled in
 *  the y-axis gutter. */
export interface ChartLane {
  label: string
  spans: { from: number; to: number; color: string; hatch?: boolean; text?: string }[]
}

export type { ChartOverlay }

/** A label on the plot at (t, value), optionally with a dot there: a day's total over its hump, a marked value. */
export interface ChartNote {
  t: number
  value: number
  text: string
  /** Smaller, muted text after it. */
  sub?: string
  /** CSS custom property or colour of the text and the dot. */
  color: string
  dot?: 'filled' | 'ring'
  /** Where the text sits: centred over t (default), or to its right or left. */
  align?: 'center' | 'right' | 'left'
}

// a lane's height and the space between the plot and the first lane, CSS px
const LANE_H = 18
const LANE_GAP = 6

/** Diagonal hatching on the sunk surface, for spans that are off. */
function hatchPattern(ctx: CanvasRenderingContext2D, dpr: number): CanvasPattern | string {
  const size = Math.round(5 * dpr)
  const tile = document.createElement('canvas')
  tile.width = size
  tile.height = size
  const t = tile.getContext('2d')
  if (!t) return cssColor('--surface-sunk')
  t.fillStyle = cssColor('--surface-sunk')
  t.fillRect(0, 0, size, size)
  t.strokeStyle = cssColor('--ink-faint')
  t.lineWidth = Math.max(1, dpr * 0.75)
  t.beginPath()
  t.moveTo(0, size)
  t.lineTo(size, 0)
  t.stroke()
  return ctx.createPattern(tile, 'repeat') ?? cssColor('--surface-sunk')
}

interface TimeChartProps {
  x: number[]
  series: ChartSeries[]
  ariaLabel: string
  height?: number
  yFormat?: (value: number) => string
  yRange?: [number | null, number | null]
  /** Fit the y-axis to the visible data instead of uPlot's zero-including default (ignored with yRange). */
  fit?: FitOptions
  /** Zoomed time window in unix seconds; null shows all of x. */
  xRange?: [number, number] | null
  /** Turns on drag-to-zoom: called with the selected window, or null on double-click. */
  onZoom?: (range: [number, number] | null) => void
  syncKey?: string
  timeZone?: string
  bands?: [number, number][]
  /** Ranges washed in the past tint (measured history). */
  shade?: [number, number][]
  markers?: number[]
  now?: number
  /** Width every legend value takes, so rows don't reflow as values change ("0 W" vs "−20.00 kW"); default 10ch. */
  legendValueWidth?: string
  /** Marks drawn as bars across the plot; a strip of ticks needs no series. */
  ticks?: ChartTick[]
  /** Called with the tick nearest a click (within a few pixels). */
  onTick?: (tick: ChartTick) => void
  /** No legend and no y-axis labels (the y-axis keeps its width so the time axis lines up with the charts above). */
  compact?: boolean
  /** A value popup beside the cursor instead of a live legend; `tag` labels the slot under it ("measured"), `extra`
   *  adds rows under the lines' rows (what a lane says there). */
  popup?: { tag?: (t: number) => PopupTag | null; extra?: (t: number, time: number) => PopupExtra[] }
  /** Leave out uPlot's legend (the page draws its own key). */
  legend?: boolean
  /** Each x is a slot's start: the cursor reads the slot the pointer is in instead of the nearest start. */
  snapToSlot?: boolean
  /** Rows of spans under the plot, on the same time axis. */
  lanes?: ChartLane[]
  /** Labels (and dots) on the plot. */
  notes?: ChartNote[]
  /** Lines with times of their own, off the slot grid (market commands); the y-axis fits them too. */
  overlays?: ChartOverlay[]
}

const NONE: never[] = []

/** The lanes under the plot: a sunk track each, its spans (hatched when off, with their text where it fits), and its
 *  label right-aligned in the y-axis gutter. */
function drawLanes(u: uPlot, lanes: ChartLane[], dpr: number) {
  if (lanes.length === 0) return
  const { ctx, bbox } = u
  const right = bbox.left + bbox.width
  const h = Math.round((LANE_H - 4) * dpr)
  const gap = Math.max(1, Math.round(dpr))
  const mono = cssValue('--font-code') || 'monospace'
  const body = cssValue('--font-body') || 'sans-serif'
  let hatch: CanvasPattern | string | null = null
  ctx.save()
  // uPlot leaves the axis labels' alignment set
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  lanes.forEach((lane, i) => {
    const top = Math.round(bbox.top + bbox.height + (LANE_GAP + i * LANE_H) * dpr)
    ctx.fillStyle = cssColor('--surface-sunk')
    ctx.fillRect(bbox.left, top, bbox.width, h)
    for (const span of lane.spans) {
      const a = Math.max(bbox.left, Math.round(u.valToPos(span.from, 'x', true)))
      const b = Math.min(right, Math.round(u.valToPos(span.to, 'x', true)))
      if (b - a <= gap) continue
      if (span.hatch) hatch ??= hatchPattern(ctx, dpr)
      ctx.fillStyle = span.hatch ? (hatch ?? '') : cssColor(span.color)
      ctx.fillRect(a + gap, top, b - a - gap, h)
      if (span.text) {
        ctx.font = `${11 * dpr}px ${mono}`
        const width = ctx.measureText(span.text).width
        if (width + 12 * dpr < b - a) {
          if (span.hatch) {
            // a quiet patch behind the text, so the hatching doesn't run through it
            ctx.fillStyle = cssColor('--surface-sunk')
            ctx.fillRect(a + gap + 2 * dpr, top + dpr, width + 6 * dpr, h - 2 * dpr)
          }
          ctx.fillStyle = cssColor('--ink-2')
          ctx.fillText(span.text, a + gap + 5 * dpr, top + h / 2)
        }
      }
    }
    ctx.font = `${12 * dpr}px ${body}`
    ctx.fillStyle = cssColor('--ink-muted')
    ctx.textAlign = 'right'
    ctx.fillText(lane.label, bbox.left - 8 * dpr, top + h / 2)
    ctx.textAlign = 'left'
  })
  ctx.restore()
}

/** Overlays in the order given (the last on top): each run of back-to-back spans follows their values, from and back
 *  to zero unless its base is 'none', with an optional light fill between the line and zero. */
function drawOverlays(u: uPlot, overlays: ChartOverlay[], dpr: number) {
  if (overlays.length === 0) return
  const { ctx, bbox } = u
  const zero = u.valToPos(0, 'y', true)
  ctx.save()
  ctx.beginPath()
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height)
  ctx.clip()
  for (const overlay of overlays) {
    const color = cssColor(overlay.color)
    ctx.strokeStyle = color
    ctx.lineWidth = (overlay.width ?? 2) * dpr
    ctx.setLineDash((overlay.dash ?? []).map((d) => d * dpr))
    if (overlay.fill) {
      ctx.fillStyle = withAlpha(color, overlay.fill)
      for (const span of overlay.spans) {
        const a = u.valToPos(span.from, 'x', true)
        const y = u.valToPos(span.value, 'y', true)
        ctx.fillRect(a, Math.min(y, zero), u.valToPos(span.to, 'x', true) - a, Math.abs(zero - y))
      }
    }
    ctx.beginPath()
    for (const run of overlayRuns(overlay.spans, overlay.base)) {
      run.forEach(([t, v], i) => {
        const x = u.valToPos(t, 'x', true)
        const y = u.valToPos(v, 'y', true)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
    }
    ctx.stroke()
  }
  ctx.restore()
}

/** Labels on the plot: the text (and its muted sub) above the point or beside its dot, kept inside the plot. Where a
 *  label would run into one drawn before it (many days on a narrow chart), its sub goes, and then the label. */
function drawNotes(u: uPlot, notes: ChartNote[], dpr: number) {
  if (notes.length === 0) return
  const { ctx, bbox } = u
  const mono = cssValue('--font-code') || 'monospace'
  const drawn: { left: number; right: number; base: number }[] = []
  const gap = 8 * dpr
  const free = (left: number, right: number, base: number) =>
    !drawn.some((d) => left < d.right + gap && right > d.left - gap && Math.abs(base - d.base) < 14 * dpr)
  ctx.save()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  for (const note of notes) {
    const px = u.valToPos(note.t, 'x', true)
    const py = u.valToPos(note.value, 'y', true)
    if (px < bbox.left - 1 || px > bbox.left + bbox.width + 1) continue
    const color = cssColor(note.color)
    if (note.dot) {
      ctx.beginPath()
      ctx.arc(px, py, 5 * dpr, 0, Math.PI * 2)
      ctx.fillStyle = note.dot === 'filled' ? color : cssColor('--panel')
      ctx.fill()
      ctx.lineWidth = 2 * dpr
      ctx.strokeStyle = color
      ctx.stroke()
    }
    const bold = `600 ${12.5 * dpr}px ${mono}`
    const light = `400 ${11 * dpr}px ${mono}`
    ctx.font = bold
    const main = ctx.measureText(note.text).width
    ctx.font = light
    const sub = note.sub ? 6 * dpr + ctx.measureText(note.sub).width : 0
    const align = note.align ?? 'center'
    const leftFor = (width: number) => {
      const left = align === 'center' ? px - width / 2 : align === 'right' ? px + 10 * dpr : px - 10 * dpr - width
      return Math.min(Math.max(left, bbox.left + 2 * dpr), bbox.left + bbox.width - width - 2 * dpr)
    }
    const base = Math.max(bbox.top + 13 * dpr, note.dot ? py - 9 * dpr : py - 8 * dpr)
    let withSub = sub > 0
    let left = leftFor(main + sub)
    if (!free(left, left + main + sub, base)) {
      withSub = false
      left = leftFor(main)
      if (!free(left, left + main, base)) continue
    }
    drawn.push({ left, right: left + main + (withSub ? sub : 0), base })
    ctx.font = bold
    ctx.fillStyle = color
    ctx.fillText(note.text, left, base)
    if (withSub && note.sub) {
      ctx.font = light
      ctx.fillStyle = cssColor('--ink-muted')
      ctx.fillText(note.sub, left + main + 6 * dpr, base)
    }
  }
  ctx.restore()
}

const axisFormats = new Map<string, { time: Intl.DateTimeFormat; day: Intl.DateTimeFormat }>()
/** 24-hour axis labels in the chart's timezone; the date is added at midnight and on the first tick. */
function axisLabels(splits: number[], timeZone?: string): string[] {
  const key = timeZone ?? ''
  let fmt = axisFormats.get(key)
  if (!fmt) {
    fmt = {
      time: new Intl.DateTimeFormat(undefined, { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }),
      day: new Intl.DateTimeFormat(undefined, { timeZone, weekday: 'short', day: 'numeric' }),
    }
    axisFormats.set(key, fmt)
  }
  return splits.map((ts, i) => {
    const d = new Date(ts * 1000)
    const time = fmt.time.format(d)
    return i === 0 || time === '00:00' ? `${time}\n${fmt.day.format(d)}` : time
  })
}

const timeOnly = new Map<string, Intl.DateTimeFormat>()
function readoutTime(ts: number, timeZone?: string): string {
  const key = timeZone ?? ''
  let fmt = timeOnly.get(key)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(undefined, {
      timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    })
    timeOnly.set(key, fmt)
  }
  return fmt.format(new Date(ts * 1000))
}

/** Show `range` (or all of `x` when null) on the chart's time axis; the y-axis refits to it. */
function applyXRange(chart: uPlot, x: number[], range: [number, number] | null) {
  const first = x[0]
  const last = x[x.length - 1]
  if (range) chart.setScale('x', { min: range[0], max: range[1] })
  else if (first !== undefined && last !== undefined) chart.setScale('x', { min: first, max: last })
}

export function TimeChart({
  x, series, ariaLabel, height = 220, yFormat, yRange, fit, xRange = null, onZoom, syncKey, timeZone, bands = [],
  shade = [], markers = [], now, legendValueWidth, ticks = [], onTick, compact = false, popup, legend = true,
  snapToSlot = false, lanes = NONE, notes = NONE, overlays = NONE,
}: TimeChartProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const theme = useThemeVersion()
  // Everything the hooks and formatters read comes from this ref, so data, zoom and unit changes don't need a rebuild.
  const extras = useRef({
    bands, shade, markers, now, x, xRange, onZoom, ticks, onTick, yFormat, series, popup, lanes, notes, overlays,
  })
  useEffect(() => {
    extras.current = {
      bands, shade, markers, now, x, xRange, onZoom, ticks, onTick, yFormat, series, popup, lanes, notes, overlays,
    }
  })
  const [cursor] = useState(createCursorStore)
  const readPopup = useCallback(
    () => ({
      series: extras.current.series.map((s) => ({
        ...s,
        area: s.below !== undefined || Boolean(s.fill) || s.column === 'stack',
      })),
      x: extras.current.x,
      timeZone,
      tag: extras.current.popup?.tag,
      extra: extras.current.popup?.extra,
    }),
    [timeZone],
  )

  const zoomable = Boolean(onZoom)
  const withPopup = Boolean(popup) && !compact
  const specKey = JSON.stringify([
    series.map((s) => [s.label, s.color, s.width, s.dash, s.step, s.fill, s.then, s.below, s.helper, s.muted, s.column]),
    height, yRange, fit, zoomable, syncKey, timeZone, theme, compact, Boolean(yFormat), withPopup, legend, snapToSlot,
    lanes.length,
  ])
  const columns = series.some((s) => s.column)

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ink = cssColor('--ink-muted')
    const grid = cssColor('--chart-grid')
    // lanes sit between the plot and the time axis's labels, which move down to make room
    const lanesPx = lanes.length ? LANE_GAP + lanes.length * LANE_H : 0
    const stepped = uPlot.paths.stepped?.({ align: 1 })
    const hasColumns = series.some((s) => s.column)
    // One column per slot for a 'stack' or 'cap' series, read from extras so new data needs no rebuild: a gap between
    // neighbours, a hairline between stacked parts, faded in a shaded range (a forecast).
    const columnPaths: uPlot.Series.PathBuilder = (u, si) => {
      const fill = new Map<string, Path2D>()
      const paths = { stroke: null, fill, clip: null, flags: 0 }
      const meta = extras.current.series[si - 1]
      if (!meta?.column || (meta.column === 'cap' && meta.width === 0)) return paths
      const xs = u.data[0]
      const ys = u.data[si] ?? []
      const lows = meta.column === 'stack' && meta.below !== undefined ? u.data[meta.below + 1] : undefined
      const dpr = uPlot.pxRatio
      const hair = Math.max(1, Math.round(dpr))
      const cap = Math.max(2, Math.round(2 * dpr))
      const color = cssColor(meta.color)
      const faded = withAlpha(color, FADED)
      const pathFor = (style: string) => {
        let path = fill.get(style)
        if (!path) {
          path = new Path2D()
          fill.set(style, path)
        }
        return path
      }
      const { left: plotLeft, width: plotWidth } = u.bbox
      for (let i = 0; i + 1 < xs.length; i++) {
        const v = ys[i]
        const start = xs[i]
        const end = xs[i + 1]
        if (v === null || v === undefined || start === undefined || end === undefined) continue
        const a = u.valToPos(start, 'x', true)
        const b = u.valToPos(end, 'x', true)
        if (b < plotLeft || a > plotLeft + plotWidth) continue
        const gap = columnGap((b - a) / dpr) * dpr
        const left = Math.round(a + gap / 2)
        const width = Math.round(b - gap / 2) - left
        if (width <= 0) continue
        const path = pathFor(inRanges(start, end, extras.current.bands) ? faded : color)
        if (meta.column === 'cap') {
          path.rect(left, Math.round(u.valToPos(v, 'y', true) - cap / 2), width, cap)
          continue
        }
        const seg = columnSegment(lows?.[i] ?? 0, v)
        if (!seg) continue
        let top = Math.round(u.valToPos(seg.to, 'y', true))
        let bottom = Math.round(u.valToPos(seg.from, 'y', true))
        if (seg.inset === 'low') bottom -= hair
        else if (seg.inset === 'high') top += hair
        if (bottom > top) path.rect(left, top, width, bottom - top)
      }
      return paths
    }
    // the column at idx in plot pixels: from the lowest to the highest edge of its parts and its cap
    const columnAt = (u: uPlot, idx: number): CursorAt['column'] => {
      const start = u.data[0][idx]
      const end = u.data[0][idx + 1]
      if (start === undefined || end === undefined) return undefined
      let lo = 0
      let hi = 0
      let any = false
      extras.current.series.forEach((meta, k) => {
        if (!meta.column || !u.series[k + 1]?.show || (meta.column === 'cap' && meta.width === 0)) return
        const v = u.data[k + 1]?.[idx]
        if (v === null || v === undefined) return
        const base = meta.column === 'cap' ? v : meta.below !== undefined ? (u.data[meta.below + 1]?.[idx] ?? 0) : 0
        lo = Math.min(lo, v, base)
        hi = Math.max(hi, v, base)
        any = true
      })
      if (!any) return undefined
      const a = u.valToPos(start, 'x')
      const b = u.valToPos(end, 'x')
      const gap = columnGap(b - a)
      const top = u.valToPos(hi, 'y')
      return { left: a + gap / 2, width: b - a - gap, top, height: u.valToPos(lo, 'y') - top }
    }
    // the popup follows the cursor once per frame; only the chart under the pointer marks the nearest line
    let hovered = false
    let frame: number | null = null
    const follow = (u: uPlot) => {
      frame = null
      const idx = u.cursor.idx
      const left = u.cursor.left ?? -1
      if (idx === null || idx === undefined || left < 0 || u.select.width > 0) {
        cursor.setAt(null)
        return
      }
      const points: CursorAt['points'] = []
      u.series.forEach((s, i) => {
        const meta = extras.current.series[i - 1]
        // lines that aren't drawn (helpers, parts switched off) can't be the one nearest the pointer; columns are ringed
        if (i === 0 || !s.show || !meta || meta.then || meta.helper || meta.column || meta.width === 0) return
        const v = u.data[i]?.[idx]
        if (v !== null && v !== undefined) points.push({ series: i - 1, y: u.valToPos(v, 'y') })
      })
      const column = hasColumns ? columnAt(u, idx) : undefined
      cursor.setAt({
        idx,
        time: u.posToVal(left, 'x'),
        left: column ? column.left + column.width / 2 : left,
        pointerY: hovered ? (u.cursor.top ?? null) : null,
        points,
        width: u.over.clientWidth,
        height: u.over.clientHeight,
        column,
      })
    }
    const opts: uPlot.Options = {
      width: Math.max(320, el.clientWidth),
      height,
      tzDate: timeZone ? (ts) => uPlot.tzDate(new Date(ts * 1000), timeZone) : undefined,
      cursor: {
        sync: syncKey ? { key: syncKey, setSeries: false } : undefined,
        points: { size: 8, width: 2 },
        // Zooming: uPlot only draws the selection; the setSelect hook hands the window to onZoom
        drag: zoomable ? { x: true, y: false, setScale: false } : { x: false, y: false },
        // uPlot's own double-click reset would bypass the parent's zoom state; ours is in the ready hook
        bind: zoomable ? { dblclick: () => null } : undefined,
        // on the start of the slot under the pointer, so the nearest index is that slot (and synced charts agree)
        ...(snapToSlot
          ? {
              move: (u: uPlot, left: number, top: number): [number, number] => {
                const xs = u.data[0]
                if (left < 0 || xs.length === 0) return [left, top]
                const start = xs[slotIndex(xs, u.posToVal(left, 'x'))]
                return [start === undefined ? left : u.valToPos(start, 'x'), top]
              },
            }
          : {}),
      },
      legend: { show: !compact && legend, live: !withPopup },
      scales: {
        x: { time: true },
        y: yRange
          ? { range: () => [yRange[0] ?? 0, yRange[1] ?? 1] }
          : fit
            ? {
                range: (u, dataMin, dataMax) => {
                  // the overlays' values in the window shown count too
                  const extent = overlayExtent(extras.current.overlays, u.scales.x?.min, u.scales.x?.max)
                  if (!extent) return fitRange(dataMin, dataMax, fit)
                  const lo = dataMin === null || dataMin === undefined ? extent[0] : Math.min(dataMin, extent[0])
                  const hi = dataMax === null || dataMax === undefined ? extent[1] : Math.max(dataMax, extent[1])
                  return fitRange(lo, hi, fit)
                },
              }
            : {},
      },
      axes: [
        {
          stroke: ink,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid, width: 1, show: lanesPx === 0 },
          values: (_u, splits) => axisLabels(splits, timeZone),
          size: 44 + lanesPx,
          gap: 5 + lanesPx,
        },
        {
          stroke: ink,
          grid: { stroke: grid, width: 1, show: !compact },
          ticks: { stroke: grid, width: 1, show: !compact },
          size: 64,
          values: compact
            ? () => []
            : yFormat
              ? (_u, splits) => splits.map((v) => (v === null ? '' : (extras.current.yFormat?.(v) ?? String(v))))
              : undefined,
        },
      ],
      series: [
        { label: 'Time', value: (_u, v) => (v === null ? '—' : readoutTime(v, timeZone)) },
        ...series.map((s, i) => ({
          label: s.label,
          stroke: s.helper || s.column ? 'transparent' : cssColor(s.color),
          width: s.helper || s.column ? 0 : (s.width ?? 2),
          dash: s.dash,
          fill: s.fill && s.below === undefined && !s.column ? withAlpha(cssColor(s.color), s.fill) : undefined,
          fillTo: s.fill && s.below === undefined && !s.column ? 0 : undefined,
          paths: s.column ? columnPaths : s.step === false ? undefined : stepped,
          points: { show: false },
          spanGaps: false,
          class: s.then
            ? 'is-then'
            : s.column
              ? 'is-column'
              : s.helper || s.muted || s.width === 0
                ? 'is-helper'
                : undefined,
          value: (_u: uPlot, v: number | null) => {
            if (v === null || v === undefined) return '—'
            const format = extras.current.series[i]?.format
            return format ? format(v) : String(v)
          },
        })),
      ],
      // stacked areas: each fills down to the series below it (columns draw their own)
      bands: series.flatMap((s, i) =>
        s.below === undefined || s.column
          ? []
          : [{ series: [i + 1, s.below + 1] as [number, number], fill: withAlpha(cssColor(s.color), s.fill ?? 1) }],
      ),
      hooks: {
        ready: [
          (u) => {
            if (withPopup) {
              cursor.setOver(u.over)
              u.over.addEventListener('mouseenter', () => {
                hovered = true
              })
              u.over.addEventListener('mouseleave', () => {
                hovered = false
              })
            }
            u.over.addEventListener('dblclick', () => extras.current.onZoom?.(null))
            // The tick nearest the pointer, within 6 px: its label as the tooltip, a click opens it
            const nearest = (event: MouseEvent): ChartTick | undefined => {
              const px = event.offsetX
              let best: ChartTick | undefined
              let bestD = 6
              for (const tick of extras.current.ticks) {
                const d = Math.abs(u.valToPos(tick.t, 'x') - px)
                if (d <= bestD) {
                  best = tick
                  bestD = d
                }
              }
              return best
            }
            u.over.addEventListener('mousemove', (event) => {
              const tick = nearest(event)
              u.over.title = tick?.label ?? ''
              u.over.style.cursor = tick && extras.current.onTick ? 'pointer' : ''
            })
            u.over.addEventListener('click', (event) => {
              const tick = nearest(event)
              if (tick) extras.current.onTick?.(tick)
            })
          },
        ],
        setCursor: [
          (u) => {
            if (withPopup && frame === null) frame = requestAnimationFrame(() => follow(u))
          },
        ],
        setSelect: [
          (u) => {
            const { left, width } = u.select
            if (width < 10) return
            extras.current.onZoom?.([u.posToVal(left, 'x'), u.posToVal(left + width, 'x')])
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false)
          },
        ],
        drawClear: [
          (u) => {
            const { ctx, bbox } = u
            ctx.save()
            const fill = (ranges: [number, number][], color: string) => {
              ctx.fillStyle = color
              for (const [a, b] of ranges) {
                const left = Math.max(bbox.left, u.valToPos(a, 'x', true))
                const right = Math.min(bbox.left + bbox.width, u.valToPos(b, 'x', true))
                if (right > left) ctx.fillRect(left, bbox.top, right - left, bbox.height)
              }
            }
            fill(extras.current.shade, cssColor('--chart-past'))
            fill(extras.current.bands, cssColor('--chart-wash'))
            ctx.restore()
          },
        ],
        draw: [
          (u) => {
            const { ctx, bbox } = u
            const line = (t: number, color: string, dash: number[]) => {
              const px = u.valToPos(t, 'x', true)
              if (px < bbox.left || px > bbox.left + bbox.width) return
              ctx.save()
              ctx.strokeStyle = color
              ctx.lineWidth = Math.max(1, window.devicePixelRatio)
              ctx.setLineDash(dash)
              ctx.beginPath()
              ctx.moveTo(px, bbox.top)
              ctx.lineTo(px, bbox.top + bbox.height)
              ctx.stroke()
              ctx.restore()
            }
            for (const m of extras.current.markers) line(m, cssColor('--chart-axis'), [])
            if (extras.current.now !== undefined) line(extras.current.now, cssColor('--chart-now'), [])
            const dpr = window.devicePixelRatio
            ctx.save()
            for (const tick of extras.current.ticks) {
              const px = u.valToPos(tick.t, 'x', true)
              if (px < bbox.left || px > bbox.left + bbox.width) continue
              ctx.fillStyle = cssColor(tick.color)
              ctx.fillRect(Math.round(px - 1.5 * dpr), bbox.top + bbox.height * 0.2, Math.round(3 * dpr), bbox.height * 0.6)
            }
            ctx.restore()
            drawOverlays(u, extras.current.overlays, dpr)
            drawLanes(u, extras.current.lanes, dpr)
            drawNotes(u, extras.current.notes, dpr)
          },
        ],
      },
    }
    const chart = new uPlot(opts, [x, ...series.map((s) => s.values)] as uPlot.AlignedData, el)
    plot.current = chart
    if (extras.current.xRange) applyXRange(chart, x, extras.current.xRange)
    const observer = new ResizeObserver(() => {
      chart.setSize({ width: Math.max(320, el.clientWidth), height })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
      cursor.setOver(null)
      chart.destroy()
      plot.current = null
    }
    // Rebuild only when the chart's shape changes; data updates go through setData below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey])

  useEffect(() => {
    const chart = plot.current
    if (!chart) return
    chart.setData([x, ...series.map((s) => s.values)] as uPlot.AlignedData)
    // setData resets the scales; keep a zoomed window
    if (extras.current.xRange) applyXRange(chart, x, extras.current.xRange)
  }, [x, series])

  useEffect(() => {
    if (plot.current) applyXRange(plot.current, extras.current.x, xRange)
  }, [xRange])

  useEffect(() => {
    plot.current?.redraw(false)
  }, [bands, shade, markers, now, ticks, lanes, notes])

  // new overlay values may move the y-axis: setting the time window again refits it
  useEffect(() => {
    if (plot.current) applyXRange(plot.current, extras.current.x, extras.current.xRange)
  }, [overlays])

  return (
    <>
      <div
        ref={wrap}
        className="time-chart"
        data-columns={columns || undefined}
        role="img"
        aria-label={ariaLabel}
        style={legendValueWidth ? ({ '--legend-value-width': legendValueWidth } as CSSProperties) : undefined}
      />
      {withPopup && <ChartPopup store={cursor} read={readPopup} />}
    </>
  )
}
