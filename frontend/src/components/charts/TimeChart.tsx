// A time-series chart on uPlot: step lines per 15-minute slot, a synced crosshair across charts,
// shaded ranges (forecast), hairlines (midnights) and a "now" marker. The live legend under the
// plot is the readout: it lists every series' value at the crosshair. Optionally the y-axis hugs
// the visible data (fit) and a drag selects a time range to zoom into (onZoom / xRange).

import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { fitRange, type FitOptions } from '../../lib/chartRange'
import { cssColor, useThemeVersion } from './useTheme'

export interface ChartSeries {
  label: string
  values: (number | null)[]
  /** CSS custom property ("--series-1") or colour. */
  color: string
  width?: number
  dash?: number[]
  /** Step line (value holds until the next point). Default true. */
  step?: boolean
  /** Readout format for the legend. */
  format?: (value: number) => string
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
  shade = [], markers = [], now,
}: TimeChartProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const theme = useThemeVersion()
  // Everything the hooks read comes from this ref, so data and zoom updates don't need a rebuild.
  const extras = useRef({ bands, shade, markers, now, x, xRange, onZoom })
  useEffect(() => {
    extras.current = { bands, shade, markers, now, x, xRange, onZoom }
  })

  const zoomable = Boolean(onZoom)
  const specKey = JSON.stringify([
    series.map((s) => [s.label, s.color, s.width, s.dash, s.step]), height, yRange, fit, zoomable, syncKey, timeZone,
    theme,
  ])

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ink = cssColor('--ink-muted')
    const grid = cssColor('--chart-grid')
    const stepped = uPlot.paths.stepped?.({ align: 1 })
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
      },
      legend: { live: true },
      scales: {
        x: { time: true },
        y: yRange
          ? { range: () => [yRange[0] ?? 0, yRange[1] ?? 1] }
          : fit
            ? { range: (_u, dataMin, dataMax) => fitRange(dataMin, dataMax, fit) }
            : {},
      },
      axes: [
        {
          stroke: ink,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid, width: 1 },
          values: (_u, splits) => axisLabels(splits, timeZone),
          size: 44,
        },
        {
          stroke: ink,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid, width: 1 },
          size: 64,
          values: yFormat ? (_u, splits) => splits.map((v) => (v === null ? '' : yFormat(v))) : undefined,
        },
      ],
      series: [
        { label: 'Time', value: (_u, v) => (v === null ? '—' : readoutTime(v, timeZone)) },
        ...series.map((s) => ({
          label: s.label,
          stroke: cssColor(s.color),
          width: s.width ?? 2,
          dash: s.dash,
          paths: s.step === false ? undefined : stepped,
          points: { show: false },
          spanGaps: false,
          value: (_u: uPlot, v: number | null) => (v === null || v === undefined ? '—' : s.format ? s.format(v) : String(v)),
        })),
      ],
      hooks: {
        ready: [
          (u) => {
            u.over.addEventListener('dblclick', () => extras.current.onZoom?.(null))
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
  }, [bands, shade, markers, now])

  return <div ref={wrap} className="time-chart" role="img" aria-label={ariaLabel} />
}
