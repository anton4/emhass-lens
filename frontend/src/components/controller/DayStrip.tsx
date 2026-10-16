import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Link, useNavigate } from 'react-router'
import { shiftDay, todayKey, zonedTime } from '../../lib/days'
import {
  stripCounts,
  stripItems,
  stripLabels,
  stripRuns,
  type StripInput,
  type StripItem,
  type StripState,
  type StripTick,
} from '../../lib/dayStrip'
import { formatClock } from '../../lib/format'
import { Lamp } from '../Lamp'
import { useNow } from '../useNow'

const FILL: Record<StripState, string> = {
  same: 'var(--lamp-green)',
  differs: 'var(--lamp-amber)',
  none: 'var(--line-neutral)',
}

// the axis's hourly ticks
const HOURS = Array.from({ length: 25 }, (_, h) => h)

const STATE_TEXT: Record<StripState, string> = {
  same: 'same as the automation',
  differs: 'the automation differed',
  none: 'not compared',
}

/** Today's decisions on a 00–24 axis: green where the automation did the same, amber where it differed, grey where
 *  nothing was compared (or the page's own fills, with the comparison on a line under them); the rule is named where
 *  it changes, and a click opens the decision. With `detail`, pointing at a mark (or focusing or tapping it) opens a
 *  popup with what it did. `ticks` mark moments over the marks (e.g. button presses). */
export function DayStrip<D = unknown>({
  inputs,
  span,
  timeZone,
  what = 'slot',
  empty,
  legend,
  footer,
  detail,
  ticks,
}: {
  inputs: StripInput<D>[]
  /** How long one decision holds, in seconds (a slot: 900). */
  span: number
  timeZone?: string
  what?: 'slot' | 'decision'
  /** Shown when nothing was decided today. */
  empty: string
  /** What the fills mean, above the strip, in place of the comparison counts in the head. */
  legend?: ReactNode
  /** Under the strip, e.g. what its line means. */
  footer?: ReactNode
  /** The popup for a mark; without it the mark has a plain tooltip. */
  detail?: (item: StripItem<D>) => ReactNode
  /** Moments marked over the strip; the page says what they are (in the legend and the popup). */
  ticks?: StripTick[]
}) {
  const navigate = useNavigate()
  const now = useNow(60_000)
  const popId = useId()
  const plot = useRef<HTMLDivElement>(null)
  const pointer = useRef<string | null>(null)
  const [width, setWidth] = useState(1000)
  const [hover, setHover] = useState<number | null>(null)
  const [pinned, setPinned] = useState<number | null>(null)
  const [focused, setFocused] = useState<number | null>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  const day = todayKey(timeZone, now)
  const start = zonedTime(day, 0, 0, timeZone).getTime() / 1000
  const end = zonedTime(shiftDay(day, 1), 0, 0, timeZone).getTime() / 1000
  const items = useMemo(() => stripItems(inputs, start, end, span), [inputs, start, end, span])
  const runs = useMemo(() => stripRuns(items), [items])
  const labels = stripLabels(items, width)
  const counts = stripCounts(items)
  const hasBand = items.some((i) => i.band)
  const nowX = Math.min(1, Math.max(0, (now.getTime() / 1000 - start) / (end - start)))
  const clock = (x: number) =>
    formatClock(new Date((start + x * (end - start)) * 1000).toISOString(), timeZone).slice(0, 5)
  // a label every three hours, every six on a narrow strip
  const labelEvery = width < 520 ? 6 : 3
  const shown = detail ? (hover ?? pinned ?? focused) : null
  const shownItem = shown === null ? undefined : items[shown]
  const tabStop = cursor !== null && cursor < items.length ? cursor : items.length - 1
  const hasItems = items.length > 0

  useLayoutEffect(() => {
    const el = plot.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth || 1000))
    observer.observe(el)
    setWidth(el.clientWidth || 1000)
    return () => observer.disconnect()
  }, [hasItems])

  // a tapped popup stays until a tap elsewhere or Escape
  useEffect(() => {
    if (pinned === null) return
    const onDown = (e: PointerEvent) => {
      if (!plot.current?.contains(e.target as Node)) setPinned(null)
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setPinned(null)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [pinned])

  const markText = (item: StripItem<D>) =>
    `${clock(item.x)}${item.label ? ` · ${item.label}` : ''}${item.fill ? '' : ` · ${STATE_TEXT[item.state]}`}`

  // one tab stop for the strip; the arrow keys move between the marks
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === 'Escape') {
      setHover(null)
      setPinned(null)
      setFocused(null)
      return
    }
    const next =
      e.key === 'ArrowRight'
        ? i + 1
        : e.key === 'ArrowLeft'
          ? i - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? items.length - 1
              : null
    if (next === null || next < 0 || next >= items.length) return
    e.preventDefault()
    setCursor(next)
    plot.current?.querySelectorAll<HTMLButtonElement>('.day-strip-mark')[next]?.focus()
  }

  const geometry = (item: StripItem<D>, i: number): CSSProperties => {
    const run = runs[i]
    const r = (on: boolean | undefined) => (on ? '3px' : '0')
    return {
      left: `${item.x * 100}%`,
      // 1 px between marks, 2 px where the fill changes
      width: `max(2px, calc(${item.w * 100}% - ${run?.end ? 2 : 1}px))`,
      borderRadius: `${r(run?.start)} ${r(run?.end)} ${r(run?.end)} ${r(run?.start)}`,
    }
  }

  return (
    <section className="panel day-strip">
      <div className="panel-head">
        <h2>
          Today, {what} by {what}
        </h2>
        {!legend && (
          <span className="day-strip-legend">
            <span className="labelled-lamp">
              <Lamp color="green" /> {counts.same} same as the automation
            </span>
            <span className="labelled-lamp">
              <Lamp color="amber" /> {counts.differs} differ
            </span>
            {counts.none > 0 && (
              <span className="labelled-lamp">
                <Lamp color="neutral" lit={false} /> {counts.none} not compared
              </span>
            )}
          </span>
        )}
      </div>
      <div className="panel-body">
        {!hasItems ? (
          <p className="muted" style={{ margin: 0 }}>
            {empty}
          </p>
        ) : (
          <>
            {legend && <div className="day-strip-key">{legend}</div>}
            <div className="day-strip-chart">
              <div className="day-strip-labels" aria-hidden="true">
                {labels.map((l) => (
                  <span
                    key={`${l.x}-${l.text}`}
                    className={l.end ? 'day-strip-label-end' : undefined}
                    style={l.end ? { right: `${(1 - l.x) * 100}%` } : { left: `${l.x * 100}%` }}
                  >
                    {l.text}
                  </span>
                ))}
              </div>
              <div className="day-strip-plot" ref={plot} onPointerLeave={() => setHover(null)}>
                <div
                  className="day-strip-track"
                  role="group"
                  aria-label={
                    legend
                      ? `Today, ${what} by ${what}: use the arrow keys to move between ${what}s`
                      : `Today: ${counts.same} ${what}s the same as the automation, ${counts.differs} different, ` +
                        `${counts.none} not compared`
                  }
                >
                  {items.map((item, i) => (
                    <button
                      key={item.x}
                      type="button"
                      className="day-strip-mark"
                      data-active={i === shown || undefined}
                      style={{ ...geometry(item, i), background: item.fill ?? FILL[item.state] }}
                      tabIndex={i === tabStop ? 0 : -1}
                      aria-label={markText(item)}
                      aria-describedby={i === shown ? popId : undefined}
                      title={detail ? undefined : markText(item)}
                      onPointerDown={(e) => {
                        pointer.current = e.pointerType
                      }}
                      onPointerEnter={(e) => {
                        if (e.pointerType !== 'touch') setHover(i)
                      }}
                      onFocus={(e) => {
                        setCursor(i)
                        if (e.currentTarget.matches(':focus-visible')) setFocused(i)
                      }}
                      onBlur={() => setFocused(null)}
                      onKeyDown={(e) => onKey(e, i)}
                      onClick={() => {
                        const touch = pointer.current === 'touch'
                        pointer.current = null
                        if (touch && detail) setPinned(pinned === i ? null : i)
                        else if (item.runId) navigate(`/runs/${item.runId}`)
                      }}
                    />
                  ))}
                  {ticks
                    ?.filter((tick) => tick.t >= start && tick.t < end)
                    .map((tick, i) => (
                      <span
                        key={`${tick.t}-${i}`}
                        className="day-strip-tick"
                        style={{ left: `${((tick.t - start) / (end - start)) * 100}%`, background: tick.color }}
                        aria-hidden="true"
                      />
                    ))}
                  <span className="day-strip-now" style={{ left: `${nowX * 100}%` }} aria-hidden="true" />
                </div>
                {hasBand && (
                  <div className="day-strip-band" aria-hidden="true">
                    {items.map((item, i) =>
                      item.band ? (
                        <span key={item.x} style={{ ...geometry(item, i), borderRadius: 0, background: item.band }} />
                      ) : null,
                    )}
                  </div>
                )}
                <div className="day-strip-axis" aria-hidden="true">
                  {HOURS.map((h) => (
                    <span
                      key={`tick-${h}`}
                      className="day-strip-hour"
                      data-major={h % labelEvery === 0 || undefined}
                      style={{ left: `${(h / 24) * 100}%` }}
                    />
                  ))}
                  {HOURS.filter((h) => h % labelEvery === 0 && Math.abs(h / 24 - nowX) * width > 34).map((h) => (
                    <span
                      key={`label-${h}`}
                      className="day-strip-hour-label"
                      data-edge={h === 0 ? 'start' : h === 24 ? 'end' : undefined}
                      style={{ left: `${(h / 24) * 100}%` }}
                    >
                      {h === 24 ? '24:00' : clock(h / 24)}
                    </span>
                  ))}
                  {nowX > 0 && nowX < 1 && (
                    <span className="day-strip-now-tag" style={{ left: `${nowX * 100}%` }}>
                      {formatClock(now.toISOString(), timeZone).slice(0, 5)}
                    </span>
                  )}
                </div>
                {detail && shownItem && (
                  <>
                    <span
                      className="day-strip-caret"
                      style={{ left: `${(shownItem.x + shownItem.w / 2) * 100}%` }}
                      aria-hidden="true"
                    />
                    <div
                      className="day-strip-pop"
                      id={popId}
                      role="tooltip"
                      style={{ '--x': `${(shownItem.x + shownItem.w / 2) * 100}%` } as CSSProperties}
                    >
                      {detail(shownItem)}
                      {hover === null && pinned === shown ? (
                        <div className="day-strip-pop-actions">
                          {shownItem.runId && <Link to={`/runs/${shownItem.runId}`}>Open run {shownItem.runId}</Link>}
                          <button type="button" onClick={() => setPinned(null)}>
                            Close
                          </button>
                        </div>
                      ) : (
                        shownItem.runId && (
                          <p className="day-strip-pop-hint">
                            {hover === shown ? 'Click' : 'Press Enter on'} the {what} to open run {shownItem.runId}.
                          </p>
                        )
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
            {footer && <div className="day-strip-footer">{footer}</div>}
          </>
        )}
      </div>
    </section>
  )
}
