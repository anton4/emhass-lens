// A time-series chart on uPlot: step lines per 15-minute slot (or stacked columns, one per slot), a synced crosshair
// across charts, shaded ranges (forecast), hairlines (midnights) and a "now" marker. The live legend under the
// plot is the readout: it lists every series' value at the crosshair; with `popup` a popup beside the
// cursor shows them instead and the legend is a plain key. Optionally the y-axis hugs the visible
// data (fit) and a drag selects a time range to zoom into (onZoom / xRange). Sessions (market sessions) are bands
// across the plot with a flag above it; while the pointer is in one, the series fade so its overlays stand out.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { fadeStops, onFadedSide, scaleAlpha, splitOffset, type FadeSide } from '../../lib/chartFade'
import { applyKey, keyCommand, keyHint, type KeyStep } from '../../lib/chartKeys'
import { momentLabel, popupRows, readoutText, slotRange } from '../../lib/chartPopup'
import { rangeLabel, spanLabel } from '../../lib/chartTime'
import { columnGap, columnSegment, inRanges, slotIndex } from '../../lib/chartColumns'
import { groupFlags, layoutFlags } from '../../lib/chartFlags'
import {
  dragPan,
  fitRange,
  overlayAt,
  overlayExtent,
  overlayRuns,
  pinchWindow,
  wheelWindow,
  type ChartGap,
  type ChartOverlay,
  type FitOptions,
} from '../../lib/chartRange'
import { ChartPopup, CursorPill } from './ChartPopup'
import {
  createCursorStore,
  type CursorAt,
  type PopupBlock,
  type PopupChip,
  type PopupExtra,
  type PopupTag,
} from './cursorStore'
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
  /** The value at the pointer's own moment (the grid measured finer than the slots), or null: the popup shows it, with
   *  the slot's value as its note. */
  moment?: (time: number) => number | null
  /** The lowest and highest reading behind `moment`'s value (a long window's bucket), or null: a popup row of its own. */
  momentRange?: (time: number) => [number, number] | null
  /** The popup's first row, wherever the series is drawn. */
  lead?: boolean
  /** Only the edge another series fills down to: no line, no popup row, no cursor dot. */
  helper?: boolean
  /** A part switched off: faded in the popup, no cursor dot. */
  muted?: boolean
  /** The popup's last row, under a rule (or its header's value, with the popup's `totalInHead`). */
  total?: boolean
  /** The popup row also gives its share of the total ("41 %"). */
  share?: boolean
  /** Where its popup row goes: lower first; rows without one keep their order, before ranked ones. */
  popupRank?: number
  /** Its popup row sits under a rule. */
  rule?: boolean
  /** A column per slot instead of a line: 'stack' fills from the series `below` (or zero) to the value, a hairline
   *  apart from the part it sits on; 'cap' is a short bar at the value across the column (none at `width` 0). Columns
   *  in a shaded range (a forecast) are faded. */
  column?: 'stack' | 'cap'
  /** Drawn fainter on the chart's `split` side: the line at `line` and the fill at `fill` of their own opacity (a fill
   *  of 0 isn't drawn there). */
  fade?: { line?: number; fill?: number }
}

/** A moment the chart is drawn faded on one side of (the plan right of now): the series, overlays and gaps that say
 *  how much, and the side washed in `wash` (a CSS custom property or colour). */
export interface ChartSplit {
  at: number
  side: FadeSide
  wash?: string
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
  /** A block from `t` to here instead of a bar (a run until the next one). */
  until?: number
  /** Only its outline (the next run, not run yet). */
  outline?: boolean
}

/** A row of spans between the plot and the time axis (tariff periods, export limits, a load's window), labelled in
 *  the y-axis gutter. */
export interface ChartLane {
  label: string
  spans: {
    from: number
    to: number
    color: string
    hatch?: boolean
    text?: string
    /** A longer text, drawn instead of `text` where it fits. */
    long?: string
    /** The text's colour (default --ink-2). */
    ink?: string
    /** Stretches hatched across the span in their colour (a shortfall), as the chart hatches its gaps. */
    marks?: { from: number; to: number; color: string }[]
    /** Clicking the span calls onSession with this. */
    id?: string
  }[]
}

/** A stretch shaded across the plot in its own colour, with a flag above the plot that names it (a market session):
 *  longer while the pointer is in it, just `short` where there is no room. Sessions of one `group` whose flags would
 *  touch share the first one's flag, with " +N" for the others. Clicking a flag calls onSession with its sessions. */
export interface ChartSession {
  id: string
  from: number
  to: number
  /** Sessions of one group (direction) share a flag where theirs would touch. */
  group?: string
  /** CSS custom property or colour: the band's tint and the flag's fill. */
  color: string
  /** The flag's text colour. */
  ink: string
  label: string
  detail: string
  short: string
  /** Hatched in its colour instead of a flat tint (an aFRR session). */
  hatch?: boolean
}

export type { ChartGap, ChartOverlay }

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
  /** 'pill': on a rounded panel-coloured box; 'callout': light text on a dark box with a stem down to the point. */
  look?: 'plain' | 'pill' | 'callout'
  /** Pinned to the top of the plot, whatever `value` is (a note about a stretch of time). */
  top?: boolean
}

/** A stretch hatched across the whole plot (a forecast, a plan too old to trust, readings that are missing), with an
 *  optional label at its top-left. */
export interface ChartHatch {
  from: number
  to: number
  /** CSS custom property or colour of the lines (default --chart-hatch). */
  color?: string
  label?: string
}

// a lane's height and the space between the plot and the first lane, CSS px
const LANE_H = 18
const LANE_GAP = 6
// the room above the plot for the sessions' flags (two rows), a flag's height and a row's, CSS px
const FLAG_ROOM = 49
const FLAG_H = 19
const FLAG_ROW = 23
// how strongly the series are drawn while the pointer is in a session
const DIMMED = 0.3

/** A clickable rectangle drawn on the canvas outside the plot (a flag, a lane span), in CSS px. */
interface Hit {
  /** The sessions or lane span it stands for. */
  ids: string[]
  left: number
  top: number
  right: number
  bottom: number
  title: string
}

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
   *  adds rows under the lines' rows (what a lane says there), `head` replaces the slot in its header (the pointer's
   *  own moment) and `block` adds a tinted block above the rows. */
  popup?: {
    tag?: (t: number) => PopupTag | null
    extra?: (t: number, time: number) => PopupExtra[]
    head?: (t: number, time: number) => string | null
    block?: (t: number, time: number) => PopupBlock | null
    /** Rows right after the lead row (the commanded target, under the grid's reading). */
    lead?: (t: number, time: number) => PopupExtra[]
    /** The total's value in the header instead of a row of its own. */
    totalInHead?: boolean
    /** A muted line under the rows. */
    note?: (t: number, time: number) => string | null
    /** 'chip': a small chip at the top of the cursor line instead of the popup, its lines from `chip`. */
    style?: 'popup' | 'chip'
    chip?: (t: number, time: number) => PopupChip[]
  }
  /** Leave out uPlot's legend (the page draws its own key). */
  legend?: boolean
  /** Each x is a slot's start: the cursor reads the slot the pointer is in instead of the nearest start. */
  snapToSlot?: boolean
  /** Rows of spans under the plot, on the same time axis. */
  lanes?: ChartLane[]
  /** Labels (and dots) on the plot. */
  notes?: ChartNote[]
  /** Lines with times of their own, off the slot grid (market commands); the y-axis fits them too, except those with
   *  `fit: false`, which run along the edge past it. */
  overlays?: ChartOverlay[]
  /** Hatched areas between two values (a shortfall), under the overlays. */
  gaps?: ChartGap[]
  /** Bands across the plot with a flag above it (market sessions). */
  sessions?: ChartSession[]
  /** Called with the ids of a clicked flag's sessions, or of a clicked lane span. */
  onSession?: (ids: string[]) => void
  /** Draw the series, overlays and gaps that have a `fade` fainter on one side of a moment. */
  split?: ChartSplit
  /** 'ticks': the time axis keeps its gridlines but no labels (a chart above another on the same axis). */
  timeAxis?: 'labels' | 'ticks'
  /** The y-axis's width, CSS px (default 64). */
  axisWidth?: number
  /** A pill on the time axis at `now` ("now 15:32"); the axis's labels near it are left out. */
  nowLabel?: string
  /** A pill on the time axis at the cursor, with this text for its moment and the window's length (s). */
  cursorLabel?: (time: number, windowS: number) => string
  /** Stretches hatched across the plot, under the series. */
  hatches?: ChartHatch[]
  /** The cursor is a band as wide as a slot rather than a line (a chart that snaps to slots). */
  cursorBand?: boolean
  /** Focusable, with the arrow keys moving the cursor (charts sharing the syncKey follow), + and − zooming around
   *  it, Page Up/Down moving the window, Home going back to the chart's own window (onZoom(null), the cursor at
   *  `home` or now) and Escape putting the cursor away. `step` may follow the window shown (s) and the plot's width
   *  (px). A screen reader hears the values at the cursor. */
  keyboard?: { step: KeyStep | ((windowS: number, plotPx: number) => KeyStep); home?: number }
}

const NONE: never[] = []

// A drag that Escape cancelled, until the mouse button comes up: uPlot hands a drag to the charts that share its sync
// key, and each would zoom on its own when the button comes up.
let dragCancelled = false

/** The lanes under the plot: a sunk track each, its spans (hatched when off, with their marks hatched across them and
 *  their text where it fits), and its label right-aligned in the y-axis gutter. Spans with an id go into `hits`. */
function drawLanes(u: uPlot, lanes: ChartLane[], dpr: number, hits: Hit[]) {
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
      for (const mark of span.marks ?? []) {
        const ma = Math.max(a + gap, Math.round(u.valToPos(mark.from, 'x', true)))
        const mb = Math.min(b, Math.round(u.valToPos(mark.to, 'x', true)))
        if (mb <= ma) continue
        // the chart's hatching for the same stretch, on the panel so it reads the same in the bar
        const width = Math.max(mb - ma, Math.round(2 * dpr))
        ctx.fillStyle = cssColor('--panel')
        ctx.fillRect(ma, top, width, h)
        ctx.fillStyle = linePattern(ctx, cssColor(mark.color), dpr)
        ctx.fillRect(ma, top, width, h)
      }
      if (span.id) {
        hits.push({ ids: [span.id], left: a / dpr, top: top / dpr, right: b / dpr, bottom: (top + h) / dpr, title: span.long ?? span.text ?? '' })
      }
      ctx.font = `${11 * dpr}px ${mono}`
      // the longer text where it fits, else the short one where that does
      const text = [span.long, span.text].find((t) => t && ctx.measureText(t).width + 12 * dpr < b - a)
      if (text) {
        if (span.hatch) {
          // a quiet patch behind the text, so the hatching doesn't run through it
          ctx.fillStyle = cssColor('--surface-sunk')
          ctx.fillRect(a + gap + 2 * dpr, top + dpr, ctx.measureText(text).width + 6 * dpr, h - 2 * dpr)
        } else if (span.marks?.length) {
          // the span's own colour behind the text, over any marks
          ctx.fillStyle = cssColor(span.color)
          ctx.fillRect(a + gap, top, ctx.measureText(text).width + 10 * dpr, h)
        }
        ctx.fillStyle = cssColor(span.ink ?? '--ink-2')
        ctx.fillText(text, a + gap + 5 * dpr, top + h / 2)
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

/** The plot's two sides of `split` as clip rectangles, each with the opacity it is drawn at: the whole plot at 1 when
 *  there is no split or no `fade`. */
function fadeParts(
  u: uPlot,
  split: ChartSplit | undefined,
  fade: number | undefined,
): { left: number; width: number; alpha: number }[] {
  const { bbox } = u
  if (!split || fade === undefined || fade === 1) return [{ left: bbox.left, width: bbox.width, alpha: 1 }]
  const right = bbox.left + bbox.width
  const px = Math.min(Math.max(u.valToPos(split.at, 'x', true), bbox.left), right)
  return [
    { left: bbox.left, width: px - bbox.left, alpha: split.side === 'before' ? fade : 1 },
    { left: px, width: right - px, alpha: split.side === 'after' ? fade : 1 },
  ].filter((part) => part.width > 0 && part.alpha > 0)
}

/** Overlays in the order given (the last on top): each run of back-to-back spans follows their values, from and back
 *  to zero unless its base is 'none', with an optional light fill between the line and zero. One the axis doesn't fit
 *  runs along the edge where it is past the axis, with its `offScale` text there. One with a `fade` is drawn fainter
 *  on the split's side. */
function drawOverlays(u: uPlot, overlays: ChartOverlay[], dpr: number, split?: ChartSplit) {
  if (overlays.length === 0) return
  const { ctx, bbox } = u
  const zero = u.valToPos(0, 'y', true)
  ctx.save()
  ctx.beginPath()
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height)
  ctx.clip()
  for (const overlay of overlays) {
    const color = cssColor(overlay.color)
    // past the axis, a line it doesn't fit runs just inside the edge
    const inset = ((overlay.width ?? 2) / 2) * dpr
    const yOf = (v: number) => {
      const y = u.valToPos(v, 'y', true)
      return overlay.fit === false ? Math.min(Math.max(y, bbox.top + inset), bbox.top + bbox.height - inset) : y
    }
    const path = new Path2D()
    if (overlay.spans.some((span) => span.lo !== undefined && span.hi !== undefined)) envelopePath(u, overlay, yOf, path)
    else
      for (const run of overlayRuns(overlay.spans, overlay.base)) {
        run.forEach(([t, v], i) => {
          const x = u.valToPos(t, 'x', true)
          const y = yOf(v)
          if (i === 0) path.moveTo(x, y)
          else path.lineTo(x, y)
        })
      }
    for (const part of fadeParts(u, split, overlay.fade)) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(part.left, bbox.top, part.width, bbox.height)
      ctx.clip()
      ctx.globalAlpha *= part.alpha
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
      if (overlay.halo) {
        ctx.save()
        ctx.strokeStyle = cssColor('--panel')
        ctx.lineWidth = ((overlay.width ?? 2) + 3) * dpr
        ctx.lineJoin = 'round'
        ctx.setLineDash([])
        ctx.stroke(path)
        ctx.restore()
      }
      ctx.stroke(path)
      ctx.restore()
    }
    if (overlay.offScale) drawOffScale(u, overlay, color, dpr)
  }
  ctx.restore()
}

/** An overlay whose spans are means with their lowest and highest reading: within each span the line goes through its
 *  mean, down to its low, up to its high and back, so a long window still shows every spike the means would hide.
 *  Spans without bounds hold their value as steps; a gap between spans breaks the line. */
function envelopePath(u: uPlot, overlay: ChartOverlay, yOf: (v: number) => number, path: Path2D) {
  const spans = [...overlay.spans].sort((a, b) => a.from - b.from)
  let end: number | null = null
  for (const span of spans) {
    const a = u.valToPos(span.from, 'x', true)
    const b = u.valToPos(span.to, 'x', true)
    const y = yOf(span.value)
    if (end === null || Math.abs(span.from - end) >= 1) path.moveTo(a, y)
    else path.lineTo(a, y)
    if (span.lo !== undefined && span.hi !== undefined) {
      const mid = (a + b) / 2
      path.lineTo(mid, y)
      path.lineTo(mid, yOf(span.lo))
      path.lineTo(mid, yOf(span.hi))
      path.lineTo(mid, y)
    }
    path.lineTo(b, y)
    end = span.to
  }
}

/** The text of each span of `overlay` that is past the y-axis ("↓ 15.5 kW"), at its start against the edge it runs
 *  along; one that would run into the text before it, or that continues a span with the same value, gets none. */
function drawOffScale(u: uPlot, overlay: ChartOverlay, color: string, dpr: number) {
  const { ctx, bbox } = u
  const right = bbox.left + bbox.width
  const min = u.scales.y?.min ?? -Infinity
  const max = u.scales.y?.max ?? Infinity
  const h = 16 * dpr
  const pad = 4 * dpr
  ctx.save()
  ctx.font = `500 ${11.5 * dpr}px ${cssValue('--font-code') || 'monospace'}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  let end = -Infinity
  let prev: ChartOverlay['spans'][number] | undefined
  for (const span of overlay.spans) {
    const same = prev !== undefined && Math.abs(span.from - prev.to) < 1 && span.value === prev.value
    prev = span
    const above = span.value > max
    if (same || (!above && span.value >= min)) continue
    const a = u.valToPos(span.from, 'x', true)
    if (a > right || u.valToPos(span.to, 'x', true) < bbox.left) continue
    const text = overlay.offScale?.(span.value)
    if (!text) continue
    const width = ctx.measureText(text).width + 2 * pad
    const left = Math.min(Math.max(a, bbox.left) + pad, right - width)
    if (left < end + pad) continue
    const top = above ? bbox.top + 5 * dpr : bbox.top + bbox.height - 5 * dpr - h
    ctx.fillStyle = withAlpha(cssColor('--panel'), 0.9)
    ctx.beginPath()
    ctx.roundRect(left, top, width, h, 4 * dpr)
    ctx.fill()
    ctx.fillStyle = color
    ctx.fillText(text, left + pad, top + h / 2 + 0.5 * dpr)
    end = left + width
  }
  ctx.restore()
}

/** Diagonal lines in `color` on nothing, for a gap's hatching. */
function linePattern(ctx: CanvasRenderingContext2D, color: string, dpr: number): CanvasPattern | string {
  const size = Math.round(5 * dpr)
  const tile = document.createElement('canvas')
  tile.width = size
  tile.height = size
  const t = tile.getContext('2d')
  if (!t) return color
  t.strokeStyle = color
  t.lineWidth = Math.max(1, 1.4 * dpr)
  t.beginPath()
  t.moveTo(-1, size + 1)
  t.lineTo(size + 1, -1)
  t.stroke()
  return ctx.createPattern(tile, 'repeat') ?? color
}

/** The gaps: a light tint of their colour, hatched, between their two values; one with a `fade` fainter on the
 *  split's side. */
function drawGaps(u: uPlot, gaps: ChartGap[], dpr: number, split?: ChartSplit) {
  if (gaps.length === 0) return
  const { ctx, bbox } = u
  ctx.save()
  ctx.beginPath()
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height)
  ctx.clip()
  for (const gap of gaps) {
    const color = cssColor(gap.color)
    const area = new Path2D()
    for (const span of gap.spans) {
      const a = u.valToPos(span.from, 'x', true)
      const b = u.valToPos(span.to, 'x', true)
      const ya = u.valToPos(span.a, 'y', true)
      const yb = u.valToPos(span.b, 'y', true)
      area.rect(a, Math.min(ya, yb), b - a, Math.abs(yb - ya))
    }
    for (const part of fadeParts(u, split, gap.fade)) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(part.left, bbox.top, part.width, bbox.height)
      ctx.clip()
      ctx.globalAlpha *= part.alpha
      ctx.fillStyle = withAlpha(color, 0.12)
      ctx.fill(area)
      ctx.fillStyle = linePattern(ctx, color, dpr)
      ctx.fill(area)
      ctx.restore()
    }
  }
  ctx.restore()
}

/** The hatches across the plot, under the series: diagonal lines in their colour. */
function drawHatches(u: uPlot, hatches: ChartHatch[], dpr: number) {
  if (hatches.length === 0) return
  const { ctx, bbox } = u
  const right = bbox.left + bbox.width
  ctx.save()
  for (const h of hatches) {
    const a = Math.max(bbox.left, u.valToPos(h.from, 'x', true))
    const b = Math.min(right, u.valToPos(h.to, 'x', true))
    if (b <= a) continue
    ctx.fillStyle = linePattern(ctx, cssColor(h.color ?? '--chart-hatch'), dpr)
    ctx.fillRect(a, bbox.top, b - a, bbox.height)
  }
  ctx.restore()
}

/** Each hatch's label at its top-left, on the panel colour so the lines don't run through it; none where it doesn't
 *  fit. */
function drawHatchLabels(u: uPlot, hatches: ChartHatch[], dpr: number) {
  const { ctx, bbox } = u
  const right = bbox.left + bbox.width
  ctx.save()
  ctx.font = `${12 * dpr}px ${cssValue('--font-body') || 'sans-serif'}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  for (const h of hatches) {
    if (!h.label) continue
    const a = Math.max(bbox.left, u.valToPos(h.from, 'x', true))
    const b = Math.min(right, u.valToPos(h.to, 'x', true))
    const w = ctx.measureText(h.label).width + 8 * dpr
    if (b - a < w + 12 * dpr) continue
    const top = bbox.top + 4 * dpr
    ctx.fillStyle = cssColor('--panel')
    ctx.beginPath()
    ctx.roundRect(a + 6 * dpr, top, w, 18 * dpr, 4 * dpr)
    ctx.fill()
    ctx.fillStyle = cssColor('--ink-2')
    ctx.fillText(h.label, a + 10 * dpr, top + 9 * dpr)
  }
  ctx.restore()
}

/** The width of a slot (the first two x values apart) as --slot-px on the chart, for a cursor drawn as a band. */
function slotWidth(u: uPlot) {
  const xs = u.data[0]
  const a = xs[0]
  const b = xs[1]
  if (a === undefined || b === undefined) return
  const px = Math.max(1, u.valToPos(b, 'x') - u.valToPos(a, 'x'))
  u.root.style.setProperty('--slot-px', `${px}px`)
}

/** The sessions' bands, under the series: a light tint of their colour (hatched in it for an aFRR session) with a
 *  3 px edge along the top. */
function drawSessionBands(u: uPlot, sessions: ChartSession[], dpr: number) {
  if (sessions.length === 0) return
  const { ctx, bbox } = u
  const right = bbox.left + bbox.width
  ctx.save()
  for (const s of sessions) {
    const a = u.valToPos(s.from, 'x', true)
    const b = u.valToPos(s.to, 'x', true)
    if (b < bbox.left || a > right) continue
    const color = cssColor(s.color)
    const left = Math.max(a, bbox.left)
    const width = Math.max(Math.min(b, right) - left, 1)
    ctx.fillStyle = withAlpha(color, s.hatch ? 0.07 : 0.15)
    ctx.fillRect(left, bbox.top, width, bbox.height)
    if (s.hatch) {
      ctx.fillStyle = linePattern(ctx, withAlpha(color, 0.3), dpr)
      ctx.fillRect(left, bbox.top, width, bbox.height)
    }
    ctx.fillStyle = color
    ctx.fillRect(left, bbox.top, width, Math.round(3 * dpr))
  }
  ctx.restore()
}

/** The sessions' flags in the room above the plot, laid out so they never overlap: sessions of one group whose flags
 *  would touch share one (" +N"), and the one under the pointer shows its longer text. Each goes into `hits`. */
function drawFlags(u: uPlot, sessions: ChartSession[], hovered: string | null, dpr: number, hits: Hit[]) {
  if (sessions.length === 0) return
  const { ctx, bbox } = u
  const right = bbox.left + bbox.width
  const pad = 8 * dpr
  const gap = 4 * dpr
  ctx.save()
  ctx.font = `600 ${11.5 * dpr}px ${cssValue('--font-body') || 'sans-serif'}`
  const measure = (text: string) => ctx.measureText(text).width + 2 * pad
  const shown = sessions.flatMap((s) => {
    const a = u.valToPos(s.from, 'x', true)
    const b = u.valToPos(s.to, 'x', true)
    return b < bbox.left || a > right ? [] : [{ s, at: a, group: s.group ?? s.id }]
  })
  const more = (run: unknown[]) => (run.length > 1 ? ` +${run.length - 1}` : '')
  // grouped by the plain label, so the pointer's moving doesn't regroup them
  const runs = groupFlags(shown, (run) => measure(run[0]!.s.label + more(run)), gap)
  const texts = new Map<string, string[]>()
  const members = new Map<string, ChartSession[]>()
  const items = runs.map((run) => {
    const first = run[0]!
    const over = run.find((m) => m.s.id === hovered)?.s
    const options = [...(over ? [over.detail] : []), first.s.label + more(run), first.s.short + more(run)]
    texts.set(first.s.id, options)
    members.set(first.s.id, run.map((m) => m.s))
    return { id: first.s.id, at: first.at, widths: options.map(measure), hovered: over !== undefined }
  })
  const h = FLAG_H * dpr
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  const at = new Map(items.map((i) => [i.id, i.at]))
  for (const flag of layoutFlags(items, bbox.left, right, gap)) {
    const group = members.get(flag.id) ?? []
    const s = group[0]
    const text = texts.get(flag.id)?.[flag.text]
    if (!s || text === undefined) continue
    const top = bbox.top - (FLAG_ROOM - 3 - flag.row * FLAG_ROW) * dpr
    ctx.fillStyle = cssColor(s.color)
    // a stem from the flag down to the plot, at its session's start
    const stem = Math.min(Math.max(at.get(flag.id) ?? flag.left, flag.left + h / 2), flag.left + flag.width - h / 2)
    ctx.fillRect(Math.round(stem - dpr), top + h - dpr, Math.max(1, Math.round(2 * dpr)), bbox.top - top - h + dpr)
    ctx.beginPath()
    ctx.roundRect(flag.left, top, flag.width, h, h / 2)
    ctx.fill()
    ctx.fillStyle = cssColor(s.ink)
    ctx.fillText(text, flag.left + pad, top + h / 2 + 0.5 * dpr)
    hits.push({
      ids: group.map((m) => m.id),
      left: flag.left / dpr,
      top: top / dpr,
      right: (flag.left + flag.width) / dpr,
      bottom: (top + h) / dpr,
      title: group.map((m) => m.detail).join('\n'),
    })
  }
  ctx.restore()
}

/** Labels on the plot: the text (and its muted sub) above the point or beside its dot, kept inside the plot, plain,
 *  on a pill, or as a dark callout with a stem down to the point; a note pinned to the top sits there whatever its
 *  value. Where a label would run into one drawn before it (many days on a narrow chart), its sub goes, and then the
 *  label. */
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
    const py = note.top ? bbox.top : u.valToPos(note.value, 'y', true)
    if (px < bbox.left - 1 || px > bbox.left + bbox.width + 1) continue
    const look = note.look ?? 'plain'
    const boxed = look !== 'plain'
    const pad = boxed ? 6 * dpr : 0
    const color = cssColor(note.color)
    if (note.dot && !note.top) {
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
      const w = width + 2 * pad
      const left = align === 'center' ? px - w / 2 : align === 'right' ? px + 10 * dpr : px - 10 * dpr - w
      return Math.min(Math.max(left, bbox.left + 2 * dpr), bbox.left + bbox.width - w - 2 * dpr) + pad
    }
    // the text's baseline: above the point (or its dot, or the callout's stem), or just under the top for a pinned note
    const lift = look === 'callout' ? 16 * dpr : boxed ? 11 * dpr : note.dot ? 9 * dpr : 8 * dpr
    const base = note.top
      ? bbox.top + (boxed ? 17 * dpr : 13 * dpr)
      : Math.max(bbox.top + (boxed ? 17 * dpr : 13 * dpr), py - lift)
    let withSub = sub > 0
    let left = leftFor(main + sub)
    if (!free(left - pad, left + main + sub + pad, base)) {
      withSub = false
      left = leftFor(main)
      if (!free(left - pad, left + main + pad, base)) continue
    }
    const width = main + (withSub ? sub : 0)
    drawn.push({ left: left - pad, right: left + width + pad, base })
    if (boxed) {
      const h = 18 * dpr
      const top = base - 13 * dpr
      ctx.fillStyle = look === 'callout' ? cssColor('--ink') : cssColor('--panel')
      ctx.beginPath()
      ctx.roundRect(left - pad, top, width + 2 * pad, h, 6 * dpr)
      ctx.fill()
      if (look === 'pill') {
        ctx.strokeStyle = cssColor('--frame')
        ctx.lineWidth = Math.max(1, dpr)
        ctx.stroke()
      } else if (!note.top && py > top + h) {
        // the stem from the box down to the point
        ctx.fillRect(Math.round(px - 0.75 * dpr), top + h, Math.max(1, 1.5 * dpr), py - top - h)
      }
    }
    ctx.font = bold
    ctx.fillStyle = look === 'callout' ? cssColor('--panel') : color
    ctx.fillText(note.text, left, base)
    if (withSub && note.sub) {
      ctx.font = light
      ctx.fillStyle = look === 'callout' ? cssColor('--panel') : cssColor('--ink-muted')
      ctx.fillText(note.sub, left + main + 6 * dpr, base)
    }
  }
  ctx.restore()
}

/** The now line's pill on the time axis, under the plot and its lanes: "now 15:32" in the now line's colour. */
function drawNowPill(u: uPlot, now: number, text: string, lanesPx: number, dpr: number) {
  const { ctx, bbox } = u
  const px = u.valToPos(now, 'x', true)
  if (px < bbox.left || px > bbox.left + bbox.width) return
  ctx.save()
  ctx.font = `600 ${12 * dpr}px ${cssValue('--font-body') || 'sans-serif'}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const h = 20 * dpr
  const w = ctx.measureText(text).width + 20 * dpr
  const top = bbox.top + bbox.height + (lanesPx + 4) * dpr
  const left = Math.min(Math.max(px - w / 2, 0), ctx.canvas.width - w)
  ctx.fillStyle = cssColor('--chart-now')
  ctx.beginPath()
  ctx.roundRect(left, top, w, h, h / 2)
  ctx.fill()
  ctx.fillStyle = cssColor('--panel')
  ctx.fillText(text, left + w / 2, top + h / 2 + 0.5 * dpr)
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

/** uPlot's setCursor with its third argument, which the types leave out: publish to the charts sharing the sync key. */
function setCursorSynced(u: uPlot, left: number, top: number) {
  ;(u.setCursor as (opts: { left: number; top: number }, fire?: boolean, pub?: boolean) => void)({ left, top }, true, true)
}

/** The cursor at `time`, half-way down the plot; charts sharing the sync key follow. */
function placeCursor(u: uPlot, time: number) {
  const left = u.valToPos(time, 'x')
  if (left < 0 || left > u.over.clientWidth) return
  setCursorSynced(u, left, u.over.clientHeight / 2)
}

/** The keyboard's step for the window shown (the plot's width isn't known before the chart is drawn: 1000 px). */
function keyStepFor(
  keyboard: NonNullable<TimeChartProps['keyboard']>,
  x: number[],
  xRange: [number, number] | null,
): KeyStep {
  if (typeof keyboard.step !== 'function') return keyboard.step
  const shown = xRange ?? [x[0] ?? 0, x[x.length - 1] ?? 0]
  return keyboard.step(shown[1] - shown[0], 1000)
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
  snapToSlot = false, lanes = NONE, notes = NONE, overlays = NONE, gaps = NONE, sessions = NONE, onSession, split,
  timeAxis = 'labels', axisWidth = 64, nowLabel, cursorLabel, keyboard, hatches = NONE, cursorBand = false,
}: TimeChartProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const theme = useThemeVersion()
  // Everything the hooks and formatters read comes from this ref, so data, zoom and unit changes don't need a rebuild.
  const extras = useRef({
    bands, shade, markers, now, x, xRange, onZoom, ticks, onTick, yFormat, series, popup, lanes, notes, overlays, gaps,
    sessions, onSession, split, nowLabel, cursorLabel, keyboard, hatches,
  })
  useEffect(() => {
    extras.current = {
      bands, shade, markers, now, x, xRange, onZoom, ticks, onTick, yFormat, series, popup, lanes, notes, overlays, gaps,
      sessions, onSession, split, nowLabel, cursorLabel, keyboard, hatches,
    }
  })
  // the cursor the keyboard placed (unix s), until the mouse takes over
  const keyAt = useRef<number | null>(null)
  const [readout, setReadout] = useState('')
  const readoutTimer = useRef<number | null>(null)
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
      head: extras.current.popup?.head,
      block: extras.current.popup?.block,
      lead: extras.current.popup?.lead,
      totalInHead: extras.current.popup?.totalInHead,
      note: extras.current.popup?.note,
      style: extras.current.popup?.style,
      chip: extras.current.popup?.chip,
    }),
    [timeZone],
  )

  const zoomable = Boolean(onZoom)
  // a chip at the cursor works on a compact strip too
  const withPopup = Boolean(popup) && (!compact || popup?.style === 'chip')
  const withPill = Boolean(cursorLabel) && timeAxis === 'labels'
  const readPill = useCallback(() => {
    const xs = extras.current.x
    const shown = extras.current.xRange ?? [xs[0] ?? 0, xs[xs.length - 1] ?? 0]
    return { label: extras.current.cursorLabel, windowS: shown[1] - shown[0] }
  }, [])
  // lanes sit between the plot and the time axis's labels, which move down to make room
  const lanesPx = lanes.length ? LANE_GAP + lanes.length * LANE_H : 0
  const specKey = JSON.stringify([
    series.map((s) => [
      s.label, s.color, s.width, s.dash, s.step, s.fill, s.then, s.below, s.helper, s.muted, s.column, s.fade?.line,
      s.fade?.fill,
    ]),
    height, yRange, fit, zoomable, syncKey, timeZone, theme, compact, Boolean(yFormat), withPopup, legend, snapToSlot,
    lanes.length, sessions.length > 0, timeAxis, axisWidth, withPill, cursorBand,
  ])
  const columns = series.some((s) => s.column)

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ink = cssColor('--ink-muted')
    const grid = cssColor('--chart-grid')
    const axisFont = `12px ${cssValue('--font-body') || 'sans-serif'}`
    const labelled = timeAxis === 'labels'
    const flagged = sessions.length > 0
    // what was drawn outside the plot that a click opens, and the session the pointer is in
    let hits: Hit[] = []
    let inSession: string | null = null
    const enter = (u: uPlot) => {
      const all = extras.current.sessions
      const left = u.cursor.left ?? -1
      const time = left >= 0 ? u.posToVal(left, 'x') : null
      const id = time === null ? null : (all.find((s) => time >= s.from && time < s.to)?.id ?? null)
      if (id === inSession) return
      inSession = id
      u.series.forEach((s, i) => {
        if (i > 0) s.alpha = id ? DIMMED : 1
      })
      u.redraw(false)
    }
    const stepped = uPlot.paths.stepped?.({ align: 1 })
    // a colour drawn at `share` of its opacity on the split's side: a gradient with a hard edge at the split, read on
    // every draw so a moving split needs no rebuild
    const faded = (u: uPlot, color: string, share: number | undefined): string | CanvasGradient => {
      const split = extras.current.split
      if (!split || share === undefined || share === 1) return color
      const width = u.ctx.canvas.width
      const offset = splitOffset(u.valToPos(split.at, 'x', true), 0, width)
      const gradient = u.ctx.createLinearGradient(0, 0, width, 0)
      for (const [at, k] of fadeStops(offset, split.side, share)) gradient.addColorStop(at, scaleAlpha(color, k))
      return gradient
    }
    const strokeOf = (s: ChartSeries) => (s.helper || s.column ? 'transparent' : cssColor(s.color))
    const fillOf = (s: ChartSeries) =>
      s.fill && s.below === undefined && !s.column ? withAlpha(cssColor(s.color), s.fill) : undefined
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
      const split = extras.current.split
      const fadeFill = meta.fade?.fill
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
        const share =
          (inRanges(start, end, extras.current.bands) ? FADED : 1) *
          (split && fadeFill !== undefined && onFadedSide(start, end, split.at, split.side) ? fadeFill : 1)
        if (share <= 0) continue
        const path = pathFor(share === 1 ? color : scaleAlpha(color, share))
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
    // a drag's range as a chip over the plot ("12:45 – 16:30 · 3 h 45 min"); Escape cancels the drag
    let chip: HTMLDivElement | null = null
    const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const showChip = (u: uPlot) => {
      if (!chip) return
      const { left, width } = u.select
      // only the chart the drag is on names its range
      if (dragCancelled || width < 10 || !hovered) {
        chip.hidden = true
        return
      }
      const a = u.posToVal(left, 'x')
      const b = u.posToVal(left + width, 'x')
      chip.textContent = `${rangeLabel(a, b, zone)} · ${spanLabel(b - a)}`
      chip.style.left = `${left + width / 2}px`
      chip.hidden = false
    }
    let frame: number | null = null
    const following = withPopup || withPill
    const follow = (u: uPlot) => {
      frame = null
      const left = u.cursor.left ?? -1
      if (u.cursor.idx === null || u.cursor.idx === undefined || left < 0 || u.select.width > 0) {
        cursor.setAt(null)
        return
      }
      // the quarter-hour the pointer is in (a step holds from its start), not the nearest start
      const idx = slotIndex(u.data[0], u.posToVal(left, 'x'))
      const points: CursorAt['points'] = []
      u.series.forEach((s, i) => {
        const meta = extras.current.series[i - 1]
        // lines that aren't drawn (helpers, parts switched off) can't be the one nearest the pointer; columns are ringed
        if (i === 0 || !s.show || !meta || meta.then || meta.helper || meta.column || meta.width === 0) return
        const v = u.data[i]?.[idx]
        if (v !== null && v !== undefined) points.push({ series: i - 1, y: u.valToPos(v, 'y') })
      })
      const column = hasColumns ? columnAt(u, idx) : undefined
      // the overlays' dots at the pointer's time; one the axis doesn't fit stays at the edge it runs along
      const time = u.posToVal(left, 'x')
      const marks: CursorAt['marks'] = []
      for (const overlay of extras.current.overlays) {
        if (!overlay.dot) continue
        const v = overlayAt(overlay, time)
        if (v === null) continue
        const y = u.valToPos(v, 'y')
        marks.push({ y: Math.min(Math.max(y, 1), u.over.clientHeight - 1), color: overlay.color })
      }
      cursor.setAt({
        idx,
        time: u.posToVal(left, 'x'),
        left: column ? column.left + column.width / 2 : left,
        pointerY: hovered ? (u.cursor.top ?? null) : null,
        points,
        width: u.over.clientWidth,
        height: u.over.clientHeight,
        column,
        marks,
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
        // a step line's dot on the slot the pointer is in, as the popup reads it
        dataIdx: (u: uPlot, seriesIdx: number, closestIdx: number, xValue: number) =>
          seriesIdx > 0 && extras.current.series[seriesIdx - 1]?.step !== false ? slotIndex(u.data[0], xValue) : closestIdx,
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
      legend: {
        show: !compact && legend,
        live: !withPopup,
        // the series' own colours, not their faded gradients
        markers: {
          stroke: (_u, i) => (i > 0 && series[i - 1] ? strokeOf(series[i - 1]!) : 'transparent'),
          fill: (_u, i) => (i > 0 && series[i - 1] ? (fillOf(series[i - 1]!) ?? 'transparent') : 'transparent'),
        },
      },
      padding: flagged ? [FLAG_ROOM, null, null, null] : undefined,
      scales: {
        x: { time: true },
        y: yRange
          ? { range: () => [yRange[0] ?? 0, yRange[1] ?? 1] }
          : fit
            ? {
                range: (_u, dataMin, dataMax) => {
                  // the overlays' values in the window shown count too: the window asked for, as uPlot's x-scale may
                  // still be the old one while it applies a new window
                  const xs = extras.current.x
                  const win = extras.current.xRange ?? [xs[0], xs[xs.length - 1]]
                  const extent = overlayExtent(extras.current.overlays, win[0], win[1])
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
          font: axisFont,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid, width: 1, show: lanesPx === 0 },
          values: (u, splits) => {
            if (!labelled) return splits.map(() => '')
            const labels = axisLabels(splits, timeZone)
            // the now pill takes its place on the axis
            const at = extras.current.nowLabel ? extras.current.now : undefined
            if (at === undefined) return labels
            const nowPx = u.valToPos(at, 'x')
            return labels.map((label, i) => (Math.abs(u.valToPos(splits[i] ?? 0, 'x') - nowPx) < 52 ? '' : label))
          },
          size: (labelled ? 44 : 4) + lanesPx,
          gap: 5 + lanesPx,
        },
        {
          stroke: ink,
          font: axisFont,
          grid: { stroke: grid, width: 1, show: !compact },
          ticks: { stroke: grid, width: 1, show: !compact },
          size: axisWidth,
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
          stroke: s.fade?.line === undefined ? strokeOf(s) : (u: uPlot) => faded(u, strokeOf(s), s.fade?.line),
          width: s.helper || s.column ? 0 : (s.width ?? 2),
          dash: s.dash,
          fill: (() => {
            const fill = fillOf(s)
            return fill === undefined || s.fade?.fill === undefined ? fill : (u: uPlot) => faded(u, fill, s.fade?.fill)
          })(),
          fillTo: s.fill && s.below === undefined && !s.column ? 0 : undefined,
          paths: s.column ? columnPaths : s.step === false ? undefined : stepped,
          // the cursor's dot takes the series' own colour, not its faded gradient
          points: { show: false, stroke: strokeOf(s), fill: strokeOf(s) },
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
      bands: series.flatMap((s, i) => {
        if (s.below === undefined || s.column) return []
        const fill = withAlpha(cssColor(s.color), s.fill ?? 1)
        return [
          {
            series: [i + 1, s.below + 1] as [number, number],
            fill: s.fade?.fill === undefined ? fill : (u: uPlot) => faded(u, fill, s.fade?.fill),
          },
        ]
      }),
      hooks: {
        ready: [
          (u) => {
            if (following) cursor.setOver(u.over)
            u.over.addEventListener('mouseenter', () => {
              hovered = true
            })
            u.over.addEventListener('mouseleave', () => {
              hovered = false
            })
            u.over.addEventListener('dblclick', () => extras.current.onZoom?.(null))
            u.over.addEventListener('mousemove', () => {
              keyAt.current = null
            })
            const bounds = (): [number, number] | null => {
              const xs = extras.current.x
              const first = xs[0]
              const last = xs[xs.length - 1]
              return first !== undefined && last !== undefined && last > first ? [first, last] : null
            }
            if (zoomable) {
              chip = document.createElement('div')
              chip.className = 'chart-select-chip'
              chip.hidden = true
              u.over.appendChild(chip)
              // Shift + drag moves the window instead of selecting a range: caught on the way down, before uPlot's own
              // mousedown on the plot
              u.root.addEventListener(
                'mousedown',
                (event) => {
                  if (event.button !== 0 || !u.over.contains(event.target as Node)) return
                  const b = bounds()
                  if (!b) return
                  if (!event.shiftKey) {
                    // a range drag: Escape cancels it, on every chart it is synced to, until the button comes up
                    dragCancelled = false
                    const onKey = (e: globalThis.KeyboardEvent) => {
                      if (e.key !== 'Escape') return
                      dragCancelled = true
                      document.documentElement.classList.add('chart-drag-cancelled')
                      showChip(u)
                    }
                    // on the window, after uPlot's own mouseup on the document has fired every chart's setSelect
                    const up = () => {
                      window.removeEventListener('keydown', onKey)
                      window.removeEventListener('mouseup', up)
                      document.documentElement.classList.remove('chart-drag-cancelled')
                      dragCancelled = false
                    }
                    window.addEventListener('keydown', onKey)
                    window.addEventListener('mouseup', up)
                    return
                  }
                  event.stopPropagation()
                  event.preventDefault()
                  const from = extras.current.xRange ?? b
                  const x0 = event.clientX
                  u.root.classList.add('is-panning')
                  const move = (e: MouseEvent) =>
                    extras.current.onZoom?.(dragPan(from, e.clientX - x0, u.over.clientWidth, b))
                  const up = () => {
                    window.removeEventListener('mousemove', move)
                    window.removeEventListener('mouseup', up)
                    u.root.classList.remove('is-panning')
                  }
                  window.addEventListener('mousemove', move)
                  window.addEventListener('mouseup', up)
                },
                true,
              )
            }
            // touch: one finger reads the values where it is, two pinch to zoom and move together to pan
            const fingers = new Map<number, number>()
            let pinch: { window: [number, number]; a: number; b: number; ids: [number, number] } | null = null
            const localX = (e: PointerEvent) => e.clientX - u.over.getBoundingClientRect().left
            const readAt = (e: PointerEvent) => {
              hovered = true
              keyAt.current = null
              setCursorSynced(u, localX(e), e.clientY - u.over.getBoundingClientRect().top)
            }
            u.over.addEventListener('pointerdown', (e) => {
              if (e.pointerType !== 'touch') return
              fingers.set(e.pointerId, localX(e))
              const b = bounds()
              if (fingers.size === 2 && zoomable && b) {
                const [[ia, a], [ib, bx]] = [...fingers.entries()] as [[number, number], [number, number]]
                pinch = { window: extras.current.xRange ?? b, a, b: bx, ids: [ia, ib] }
              } else if (fingers.size === 1) readAt(e)
            })
            u.over.addEventListener('pointermove', (e) => {
              if (e.pointerType !== 'touch' || !fingers.has(e.pointerId)) return
              fingers.set(e.pointerId, localX(e))
              const b = bounds()
              if (pinch && b) {
                const a = fingers.get(pinch.ids[0])
                const bx = fingers.get(pinch.ids[1])
                if (a !== undefined && bx !== undefined) {
                  extras.current.onZoom?.(pinchWindow(pinch, { a, b: bx }, u.over.clientWidth, b))
                }
              } else if (fingers.size === 1) readAt(e)
            })
            const lift = (e: PointerEvent) => {
              fingers.delete(e.pointerId)
              if (fingers.size < 2) pinch = null
            }
            u.over.addEventListener('pointerup', lift)
            u.over.addEventListener('pointercancel', lift)
            // Safari's own pinch would zoom the page
            u.over.addEventListener('gesturestart', (e) => e.preventDefault())
            if (zoomable) {
              u.over.addEventListener(
                'wheel',
                (event) => {
                  const xs = extras.current.x
                  const first = xs[0]
                  const last = xs[xs.length - 1]
                  if (first === undefined || last === undefined) return
                  event.preventDefault()
                  const shown = extras.current.xRange ?? [first, last]
                  const next = wheelWindow(shown, [first, last], {
                    at: u.posToVal(event.offsetX, 'x'),
                    dx: event.deltaX * (event.deltaMode === 1 ? 16 : 1),
                    dy: event.deltaY * (event.deltaMode === 1 ? 16 : 1),
                    pan: event.shiftKey,
                    width: u.over.clientWidth,
                  })
                  if (next) extras.current.onZoom?.(next)
                },
                { passive: false },
              )
            }
            // The block under the pointer, or the tick nearest it within 6 px: a click opens it; a bare tick's label is the
            // tooltip (a block's is the chart's chip)
            const nearest = (event: MouseEvent): ChartTick | undefined => {
              const px = event.offsetX
              const time = u.posToVal(px, 'x')
              let best: ChartTick | undefined
              let bestD = 6
              for (const tick of extras.current.ticks) {
                if (tick.until !== undefined) {
                  if (tick.t <= time && time < tick.until && tick.id !== undefined) best = tick
                  continue
                }
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
              u.over.title = tick && tick.until === undefined ? tick.label : ''
              u.over.style.cursor = tick && extras.current.onTick ? 'pointer' : ''
            })
            u.over.addEventListener('click', (event) => {
              const tick = nearest(event)
              if (tick) extras.current.onTick?.(tick)
            })
            // flags and lane spans are drawn outside the plot, where uPlot's axis elements take the pointer: listen on
            // the wrapper and measure from the canvas
            const canvas = u.ctx.canvas
            const wrapper = canvas.parentElement ?? u.root
            const hitAt = (event: MouseEvent) => {
              const box = canvas.getBoundingClientRect()
              const px = event.clientX - box.left
              const py = event.clientY - box.top
              return hits.find((h) => px >= h.left && px <= h.right && py >= h.top && py <= h.bottom)
            }
            wrapper.addEventListener('mousemove', (event) => {
              const hit = hitAt(event)
              wrapper.style.cursor = hit && extras.current.onSession ? 'pointer' : ''
              wrapper.title = hit?.title ?? ''
            })
            wrapper.addEventListener('click', (event) => {
              const hit = hitAt(event)
              if (hit) extras.current.onSession?.(hit.ids)
            })
          },
        ],
        setCursor: [
          (u) => {
            if (following && frame === null) frame = requestAnimationFrame(() => follow(u))
            if (flagged) enter(u)
            if (chip) showChip(u)
          },
        ],
        ...(cursorBand
          ? {
              setScale: [(u: uPlot) => slotWidth(u)],
              setSize: [(u: uPlot) => slotWidth(u)],
            }
          : {}),
        setSelect: [
          (u) => {
            const { left, width } = u.select
            if (width < 10) return
            if (!dragCancelled) extras.current.onZoom?.([u.posToVal(left, 'x'), u.posToVal(left + width, 'x')])
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false)
            showChip(u)
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
            const split = extras.current.split
            if (split?.wash) {
              const xs = extras.current.x
              const first = xs[0]
              const last = xs[xs.length - 1]
              if (first !== undefined && last !== undefined) {
                fill([split.side === 'after' ? [split.at, Math.max(last, split.at)] : [Math.min(first, split.at), split.at]], cssColor(split.wash))
              }
            }
            ctx.restore()
            drawHatches(u, extras.current.hatches, window.devicePixelRatio)
            drawSessionBands(u, extras.current.sessions, window.devicePixelRatio)
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
            for (const m of extras.current.markers) line(m, cssColor('--chart-midnight'), [])
            if (extras.current.now !== undefined) line(extras.current.now, cssColor('--chart-now'), [])
            const dpr = window.devicePixelRatio
            if (labelled && extras.current.nowLabel && extras.current.now !== undefined) {
              drawNowPill(u, extras.current.now, extras.current.nowLabel, lanesPx, dpr)
            }
            ctx.save()
            for (const tick of extras.current.ticks) {
              const px = u.valToPos(tick.t, 'x', true)
              const top = bbox.top + bbox.height * 0.2
              const h = bbox.height * 0.6
              if (tick.until !== undefined) {
                // a block, a hairline short of the next one
                const a = Math.max(bbox.left, Math.round(px))
                const b = Math.min(bbox.left + bbox.width, Math.round(u.valToPos(tick.until, 'x', true)) - Math.max(1, Math.round(dpr)))
                if (b <= a) continue
                if (tick.outline) {
                  ctx.strokeStyle = cssColor(tick.color)
                  ctx.lineWidth = 1.5 * dpr
                  ctx.strokeRect(a + 0.75 * dpr, top + 0.75 * dpr, Math.max(1, b - a - 1.5 * dpr), h - 1.5 * dpr)
                } else {
                  ctx.fillStyle = cssColor(tick.color)
                  ctx.fillRect(a, top, Math.max(Math.round(dpr), b - a), h)
                }
                continue
              }
              if (px < bbox.left || px > bbox.left + bbox.width) continue
              ctx.fillStyle = cssColor(tick.color)
              ctx.fillRect(Math.round(px - 1.5 * dpr), top, Math.round(3 * dpr), h)
            }
            ctx.restore()
            hits = []
            drawGaps(u, extras.current.gaps, dpr, extras.current.split)
            drawOverlays(u, extras.current.overlays, dpr, extras.current.split)
            drawFlags(u, extras.current.sessions, inSession, dpr, hits)
            drawLanes(u, extras.current.lanes, dpr, hits)
            drawNotes(u, extras.current.notes, dpr)
            drawHatchLabels(u, extras.current.hatches, dpr)
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
    // the keyboard's cursor stays on its moment as the window moves under it
    if (plot.current && keyAt.current !== null) placeCursor(plot.current, keyAt.current)
  }, [xRange])

  useEffect(
    () => () => {
      if (readoutTimer.current !== null) window.clearTimeout(readoutTimer.current)
    },
    [],
  )

  // the values at the keyboard's cursor, read out a moment after the last key
  const announce = (time: number) => {
    if (readoutTimer.current !== null) window.clearTimeout(readoutTimer.current)
    readoutTimer.current = window.setTimeout(() => {
      const xs = extras.current.x
      const idx = slotIndex(xs, time)
      const t = xs[idx]
      if (t === undefined) return
      const p = extras.current.popup
      const head = p?.head?.(t, time) ?? (snapToSlot ? slotRange(t, xs[idx + 1] ?? t + 900, timeZone) : momentLabel(time, timeZone))
      const { rows } = popupRows(extras.current.series, idx, time)
      const extra = p?.extra?.(t, time) ?? []
      setReadout(readoutText(head, [...rows, ...extra.map((r) => ({ name: r.name, value: r.value, describe: '', then: null }))]))
    }, 300)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const u = plot.current
    const kb = extras.current.keyboard
    if (!u || !kb) return
    const cmd = keyCommand(event)
    if (!cmd) return
    const xs = extras.current.x
    const first = xs[0]
    const last = xs[xs.length - 1]
    if (first === undefined || last === undefined) return
    event.preventDefault()
    const bounds: [number, number] = [first, last]
    const shown = extras.current.xRange ?? bounds
    const step = typeof kb.step === 'function' ? kb.step(shown[1] - shown[0], u.over.clientWidth) : kb.step
    const now = extras.current.now
    const inside = (t: number) => Math.min(Math.max(t, shown[0]), shown[1])
    const start = keyAt.current ?? inside(kb.home ?? now ?? (shown[0] + shown[1]) / 2)
    const out = applyKey(cmd, { cursor: start, window: shown, bounds, step })
    if (cmd.kind === 'cancel') {
      u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false)
      hideCursor(u)
      return
    }
    if (out.home) {
      keyAt.current = kb.home ?? now ?? null
      extras.current.onZoom?.(null)
    } else {
      keyAt.current = out.cursor
      if (out.window) extras.current.onZoom?.(out.window)
    }
    if (keyAt.current !== null) {
      placeCursor(u, keyAt.current)
      announce(keyAt.current)
    }
  }
  const onBlur = () => {
    if (plot.current && keyAt.current !== null) hideCursor(plot.current)
  }
  const hideCursor = (u: uPlot) => {
    keyAt.current = null
    setCursorSynced(u, -10, -10)
  }

  useEffect(() => {
    plot.current?.redraw(false)
  }, [bands, shade, markers, now, ticks, lanes, notes, gaps, sessions, split, hatches])

  // the axis leaves out its labels near the now pill: they move with it
  useEffect(() => {
    if (nowLabel) plot.current?.redraw(false, true)
  }, [now, nowLabel])

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
        data-slot-band={cursorBand || undefined}
        role={keyboard ? 'group' : 'img'}
        aria-roledescription={keyboard ? 'chart' : undefined}
        aria-label={keyboard ? `${ariaLabel}. ${keyHint(keyStepFor(keyboard, x, xRange))}; plus and minus zoom; Home goes back` : ariaLabel}
        tabIndex={keyboard ? 0 : undefined}
        onKeyDown={keyboard ? onKeyDown : undefined}
        onBlur={keyboard ? onBlur : undefined}
        style={legendValueWidth ? ({ '--legend-value-width': legendValueWidth } as CSSProperties) : undefined}
      />
      {keyboard && (
        <div className="visually-hidden" aria-live="polite">
          {readout}
        </div>
      )}
      {withPopup && <ChartPopup store={cursor} read={readPopup} />}
      {withPill && <CursorPill store={cursor} read={readPill} offset={lanesPx + 4} />}
    </>
  )
}
