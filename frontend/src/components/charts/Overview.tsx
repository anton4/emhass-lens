// The overview under the Plan page's charts: the whole loaded range (grid power per quarter-hour, solid where it was
// measured and dashed where it is the plan, a tick at each market session, the days, now) with a brush over the
// window the charts show. Drag the brush to move the window, its edges to widen or narrow it, or press beside it to
// centre the window there; the arrow keys move it by half its width. While dragged, a chip names the window.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { brushGrab, brushWindow, clampWindow } from '../../lib/chartRange'
import { localMidnights, rangeLabel, spanLabel } from '../../lib/chartTime'
import { brushState, dayLabelEvery, overviewPaths } from '../../lib/overview'

// in line with the charts' plot: uPlot's y-axis takes the first 64 px (by default)
const LEFT = 64
const RIGHT = 8
const LINE_H = 34

const dayFormats = new Map<string, Intl.DateTimeFormat>()
function dayLabel(t: number, timeZone: string): string {
  let fmt = dayFormats.get(timeZone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric' })
    dayFormats.set(timeZone, fmt)
  }
  return fmt.format(new Date(t * 1000))
}

export function Overview({
  bounds,
  window,
  onWindow,
  line,
  sessions,
  nowS,
  timeZone,
  left = LEFT,
}: {
  bounds: [number, number]
  window: [number, number]
  onWindow: (range: [number, number]) => void
  /** Grid power per quarter-hour: slot starts (unix s) and W (+ import). */
  line: { x: number[]; values: (number | null)[] }
  sessions: { from: number; to: number; color: string }[]
  nowS: number
  timeZone: string
  /** Where the plot starts, in line with the charts' y-axis (px). */
  left?: number
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const drag = useRef<{ grabbed: 'start' | 'end' | 'move'; from: [number, number]; grabT: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [pointed, setPointed] = useState<'start' | 'end' | 'move' | null>(null)
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    setWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [])

  const plotW = Math.max(1, width - left - RIGHT)
  const [t0, t1] = bounds
  const toX = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * plotW
  const toT = (px: number) => t0 + (Math.min(Math.max(px, 0), plotW) / plotW) * (t1 - t0)
  const known = line.values.filter((v): v is number => v !== null && Number.isFinite(v))
  const lo = Math.min(0, ...known)
  const hi = Math.max(0, ...known)
  const toY = (v: number) => 2 + (1 - (v - lo) / Math.max(1, hi - lo)) * (LINE_H - 4)
  const paths = overviewPaths(line.x, line.values, nowS, toX, toY)
  const x0 = toX(window[0])
  const x1 = toX(window[1])
  const days = localMidnights(t0, t1, timeZone)
  const every = dayLabelEvery((plotW * 86400) / Math.max(1, t1 - t0))
  const range = `${rangeLabel(window[0], window[1], timeZone)} · ${spanLabel(window[1] - window[0])}`

  const local = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const scale = box.width / (event.currentTarget.offsetWidth || box.width || 1) || 1
    return (event.clientX - box.left) / scale - left
  }
  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const px = local(event)
    const t = toT(px)
    let grabbed = brushGrab(px, x0, x1)
    let from = window
    if (grabbed === null) {
      // beside the brush: centre the window there, then drag it from there
      const span = window[1] - window[0]
      from = clampWindow([t - span / 2, t + span / 2], bounds)
      onWindow(from)
      grabbed = 'move'
    }
    drag.current = { grabbed, from, grabT: t }
    setDragging(true)
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // a pointer the browser no longer tracks: the drag still follows while over the strip
    }
  }
  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) {
      setPointed(brushGrab(local(event), x0, x1))
      return
    }
    onWindow(brushWindow(d.grabbed, d.from, d.grabT, toT(local(event)), bounds))
  }
  const onUp = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const span = window[1] - window[0]
    const by = event.key === 'ArrowLeft' ? -span / 2 : event.key === 'ArrowRight' ? span / 2 : 0
    if (event.key === 'Home') onWindow(clampWindow([t0, t0 + span], bounds))
    else if (event.key === 'End') onWindow(clampWindow([t1 - span, t1], bounds))
    else if (by) onWindow(clampWindow([window[0] + by, window[1] + by], bounds))
    else return
    event.preventDefault()
  }

  return (
    <div className="overview" ref={wrap}>
      <div
        className="overview-track"
        style={{ left, right: RIGHT }}
        role="slider"
        tabIndex={0}
        aria-label="The window the charts show, within everything loaded. Arrow keys move it by half its width."
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round((x0 / plotW) * 100)}
        aria-valuetext={range}
        data-state={brushState(pointed, dragging)}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => setPointed(null)}
        onKeyDown={onKey}
      >
        {width > 0 && (
          <>
            {days.map((t, i) => (
              <span key={t} className="overview-day" style={{ left: toX(t) }}>
                {i % every === 0 && <span>{dayLabel(t, timeZone)}</span>}
              </span>
            ))}
            <svg width={plotW} height={LINE_H} aria-hidden="true">
              <path d={`M0 ${toY(0).toFixed(1)}H${plotW}`} className="overview-zero" />
              <path d={paths.past || 'M0 0'} className="overview-line" />
              <path d={paths.future || 'M0 0'} className="overview-line" data-plan />
            </svg>
            {sessions.map((s) => (
              <span
                key={`${s.from}-${s.color}`}
                className="overview-session"
                style={{ left: toX(s.from) - 1, background: `var(${s.color})` }}
              />
            ))}
            {nowS > t0 && nowS < t1 && <span className="overview-now" style={{ left: toX(nowS) }} />}
            <span className="overview-shade" style={{ left: 0, width: Math.max(0, x0) }} />
            <span className="overview-shade" style={{ left: x1, right: 0 }} />
            <span className="overview-brush" style={{ left: x0, width: Math.max(6, x1 - x0) }}>
              <span className="overview-grip" data-edge="start" data-pointed={pointed === 'start' || undefined} />
              <span className="overview-grip" data-edge="end" data-pointed={pointed === 'end' || undefined} />
            </span>
            {dragging && (
              <span className="overview-chip" style={{ left: x1 }} aria-hidden="true">
                {range}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  )
}
