// A time-series chart on uPlot: step lines per 15-minute slot, a synced crosshair across charts,
// shaded ranges (forecast), hairlines (midnights) and a "now" marker. The live legend under the
// plot is the readout: it lists every series' value at the crosshair.

import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
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
  syncKey?: string
  timeZone?: string
  bands?: [number, number][]
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

export function TimeChart({
  x, series, ariaLabel, height = 220, yFormat, yRange, syncKey, timeZone, bands = [], markers = [], now,
}: TimeChartProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const theme = useThemeVersion()
  // Everything the hooks draw reads from this ref, so data updates don't need a rebuild.
  const extras = useRef({ bands, markers, now })

  const specKey = JSON.stringify([
    series.map((s) => [s.label, s.color, s.width, s.dash, s.step]), height, yRange, syncKey, timeZone, theme,
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
        drag: { x: false, y: false },
      },
      legend: { live: true },
      scales: { x: { time: true }, y: yRange ? { range: () => [yRange[0] ?? 0, yRange[1] ?? 1] } : {} },
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
        drawClear: [
          (u) => {
            const { ctx, bbox } = u
            ctx.save()
            ctx.fillStyle = cssColor('--chart-wash')
            for (const [a, b] of extras.current.bands) {
              const left = Math.max(bbox.left, u.valToPos(a, 'x', true))
              const right = Math.min(bbox.left + bbox.width, u.valToPos(b, 'x', true))
              if (right > left) ctx.fillRect(left, bbox.top, right - left, bbox.height)
            }
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
    plot.current?.setData([x, ...series.map((s) => s.values)] as uPlot.AlignedData)
  }, [x, series])

  useEffect(() => {
    extras.current = { bands, markers, now }
    plot.current?.redraw(false)
  }, [bands, markers, now])

  return <div ref={wrap} className="time-chart" role="img" aria-label={ariaLabel} />
}
