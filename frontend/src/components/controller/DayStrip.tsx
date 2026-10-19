import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { Link, useNavigate } from 'react-router'
import { dayLabel, shiftDay, todayKey, zonedTime } from '../../lib/days'
import {
  AGREE_TONES,
  aheadItems,
  agreeRuns,
  PLAN_HATCH,
  dayHours,
  formatSpan,
  labelFits,
  segmentText,
  stripCounts,
  stripItems,
  stripRuns,
  stripSegments,
  writeCounts,
  writesText,
  type StripInput,
  type StripItem,
  type StripState,
  type StripTick,
  type WriteTick,
} from '../../lib/dayStrip'
import { formatClock } from '../../lib/format'
import { Lamp } from '../Lamp'
import { useNow } from '../useNow'
import { AgreePopup } from './AgreePopup'
import { StripFooterKey } from './StripKey'

const FILL: Record<StripState, string> = {
  same: 'var(--lamp-green)',
  differs: 'var(--lamp-amber)',
  none: 'var(--line-neutral)',
}

// how far an hour's label stays from the now tag (half of each, and a gap)
const NOW_CLEAR_PX = 48
// the differing marks an Automation popup lists
const DIFFERS_SHOWN = 4

const STATE_TEXT: Record<StripState, string> = {
  same: 'same as the automation',
  differs: 'the automation differed',
  none: 'not compared',
}

/** A row of marks as one tab stop: the arrow keys move between them and Escape puts the popup away. Pointing at a mark
 *  (or focusing or tapping it) shows its popup when the row has them (`popups`); a tapped popup stays until a tap
 *  elsewhere or Escape. `row` holds the marks and their popup. */
function useMarks(count: number, row: RefObject<HTMLDivElement | null>, popups: boolean) {
  const pointer = useRef<string | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [pinned, setPinned] = useState<number | null>(null)
  const [focused, setFocused] = useState<number | null>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  const shown = popups ? (hover ?? pinned ?? focused) : null
  const tabStop = cursor !== null && cursor < count ? cursor : count - 1

  useEffect(() => {
    if (pinned === null) return
    const onDown = (e: globalThis.PointerEvent) => {
      if (!row.current?.contains(e.target as Node)) setPinned(null)
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
  }, [pinned, row])

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
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
              ? count - 1
              : null
    if (next === null || next < 0 || next >= count) return
    e.preventDefault()
    setCursor(next)
    row.current?.querySelectorAll<HTMLButtonElement>('button[data-mark]')[next]?.focus()
  }

  /** Mark `i`'s handlers; `open` runs on a click (a tap pins the popup instead). */
  const markProps = (i: number, open: () => void) => ({
    'data-mark': '',
    'data-active': i === shown || undefined,
    tabIndex: i === tabStop ? 0 : -1,
    onPointerDown: (e: PointerEvent) => {
      pointer.current = e.pointerType
    },
    onPointerEnter: (e: PointerEvent) => {
      if (e.pointerType !== 'touch') setHover(i)
    },
    onFocus: (e: FocusEvent<HTMLButtonElement>) => {
      setCursor(i)
      if (e.currentTarget.matches(':focus-visible')) setFocused(i)
    },
    onBlur: () => setFocused(null),
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => onKeyDown(e, i),
    onClick: () => {
      const touch = pointer.current === 'touch'
      pointer.current = null
      if (touch && popups) setPinned(pinned === i ? null : i)
      else open()
    },
  })

  return {
    shown,
    /** The popup was tapped open (it gets a Close button). */
    tapped: hover === null && shown !== null && pinned === shown,
    hovered: shown !== null && hover === shown,
    close: () => setPinned(null),
    leave: () => setHover(null),
    markProps,
  }
}

/** A popup under a mark, its caret at `at` (a share of the row). */
function StripPopup({ id, at, children }: { id: string; at: number; children: ReactNode }) {
  return (
    <>
      <span className="day-strip-caret" style={{ left: `${at * 100}%` }} aria-hidden="true" />
      <div className="day-strip-pop" id={id} role="tooltip" style={{ '--x': `${at * 100}%` } as CSSProperties}>
        {children}
      </div>
    </>
  )
}

/** Under a popup: Open run and Close when it was tapped open, else how to open the run. */
function PopupFoot({
  marks,
  runId,
  noun,
}: {
  marks: ReturnType<typeof useMarks>
  runId: number | null
  noun: string
}) {
  if (marks.tapped) {
    return (
      <div className="day-strip-pop-actions">
        {runId && <Link to={`/runs/${runId}`}>Open run {runId}</Link>}
        <button type="button" onClick={marks.close}>
          Close
        </button>
      </div>
    )
  }
  if (!runId) return null
  return (
    <p className="day-strip-pop-hint">
      {marks.hovered ? 'Click' : 'Press Enter on'} the {noun} to open run {runId}.
    </p>
  )
}

/** A day's decisions (`day`, today or a past one) on its axis (23 or 25 hours on a DST day), in a row named
 *  `rowLabel`, with `chips` (the day switch) in the head: green where the
 *  automation did the same, amber where it differed, grey where nothing was compared, or the page's own fills. Each
 *  stretch of one rule carries its name inside when it fits, and a click opens the decision. With `detail`, pointing
 *  at a mark (or focusing or tapping it) opens a popup with what it did. Under it, the "Lens wrote" row of `writes`
 *  (counted in the head), and when anything was compared, the Automation row: the stretches where the automation
 *  agreed and where it differed, each with a popup (`differText` says what differed in a mark; `tally` counts a mark's
 *  decisions). `ticks` mark moments over the marks (e.g. button presses). */
export function DayStrip<D = unknown>({
  day,
  chips,
  inputs,
  span,
  timeZone,
  what = 'slot',
  rowLabel,
  subtitle,
  empty,
  legend,
  footer,
  detail,
  differText,
  tally,
  writes,
  ahead,
  ticks,
}: {
  /** The calendar day shown, "2026-10-19". */
  day: string
  /** In the head: the day switch. */
  chips?: ReactNode
  inputs: StripInput<D>[]
  /** How long one decision holds, in seconds (a slot: 900). */
  span: number
  timeZone?: string
  what?: 'slot' | 'decision'
  /** The row's name in the gutter: what its marks are ("Mode", "Charger", "Session"). */
  rowLabel: string
  /** What the strip shows, beside its title. */
  subtitle?: string
  /** Shown when nothing was decided that day. */
  empty: string
  /** What the fills mean, under the strip; without it the head counts the comparisons. */
  legend?: ReactNode
  /** More of the key under the strip, after the Automation row's. */
  footer?: ReactNode
  /** The popup for a mark; without it the mark has a plain tooltip. */
  detail?: (item: StripItem<D>) => ReactNode
  /** What the automation did differently in a mark, for the Automation row's popup. */
  differText?: (item: StripItem<D>) => string | null
  /** How many of a mark's decisions the automation agreed and differed on (one per mark by default). */
  tally?: (item: StripItem<D>) => { same: number; differs: number }
  /** The "Lens wrote" row: its ticks, what was written to (the footer key's "EMHASS Lens wrote to the inverter") and
   *  what "held" means there. */
  writes?: { ticks: WriteTick[]; target: string; held: string }
  /** Moments marked over the strip; the page says what they are (in the legend and the popup). */
  ticks?: StripTick[]
  /** The rest of today as planned, drawn hatched after the decisions so far, and a day to come (not a past day). */
  ahead?: StripInput<D>[]
}) {
  const navigate = useNavigate()
  const now = useNow(60_000)
  const mainId = useId()
  const agreeId = useId()
  const mainRow = useRef<HTMLDivElement>(null)
  const agreeRow = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1000)
  const todayDay = todayKey(timeZone, now)
  const isToday = day === todayDay
  const start = zonedTime(day, 0, 0, timeZone).getTime() / 1000
  const end = zonedTime(shiftDay(day, 1), 0, 0, timeZone).getTime() / 1000
  const nowS = Math.floor(now.getTime() / 1000)
  const items = useMemo(() => {
    const done = stripItems(inputs, start, end, span)
    if (day < todayDay || !ahead?.length) return done
    // the plan picks up where the last decision's mark ends, or now; a day to come is all plan
    const last = done.at(-1)
    const from = isToday ? Math.max(nowS, last ? start + (last.x + last.w) * (end - start) : start) : start
    return [...done, ...aheadItems(ahead, from, start, end, span)]
  }, [inputs, ahead, day, todayDay, isToday, nowS, start, end, span])
  const runs = useMemo(() => stripRuns(items), [items])
  const segments = useMemo(() => stripSegments(items), [items])
  const agree = useMemo(() => agreeRuns(items, tally), [items, tally])
  const hours = useMemo(() => dayHours(day, timeZone), [day, timeZone])
  const counts = stripCounts(items)
  const agreed = agree.reduce((n, r) => ({ same: n.same + r.same, differs: n.differs + r.differs }), {
    same: 0,
    differs: 0,
  })
  const wrote = useMemo(() => writes?.ticks.filter((t) => t.t >= start && t.t < end) ?? [], [writes, start, end])
  const written = writeCounts(wrote, start, end)
  const head = [subtitle, writesText(written)].filter(Boolean).join(' · ')
  const at = (x: number) => start + x * (end - start)
  const pos = (t: number) => `${((t - start) / (end - start)) * 100}%`
  const nowX = Math.min(1, Math.max(0, (now.getTime() / 1000 - start) / (end - start)))
  const clock = (x: number) => formatClock(new Date(at(x) * 1000).toISOString(), timeZone).slice(0, 5)
  // a label every three hours, every six on a narrow strip
  const labelEvery = width < 520 ? 6 : 3
  const main = useMarks(items.length, mainRow, !!detail)
  const auto = useMarks(agree.length, agreeRow, true)
  const shownItem = main.shown === null ? undefined : items[main.shown]
  const shownDetail = shownItem && detail ? detail(shownItem) : null
  const shownRun = auto.shown === null ? undefined : agree[auto.shown]
  const hasItems = items.length > 0
  // the run a click on an Automation stretch opens: the first mark that differed
  const runOf = (run: (typeof agree)[number]) => (run.state === 'differs' ? (items[run.items[0]!]?.runId ?? null) : null)

  useLayoutEffect(() => {
    const el = track.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth || 1000))
    observer.observe(el)
    setWidth(el.clientWidth || 1000)
    return () => observer.disconnect()
  }, [hasItems])

  const markText = (item: StripItem<D>) =>
    `${item.ahead ? 'Planned, ' : ''}${clock(item.x)}${item.label ? ` · ${item.label}` : ''}` +
    (item.fill || item.ahead ? '' : ` · ${STATE_TEXT[item.state]}`)
  const fillOf = (item: StripItem<D>) => {
    const fill = item.fill ?? FILL[item.state]
    return item.ahead ? `${PLAN_HATCH}, ${fill}` : fill
  }

  const geometry = (item: StripItem<D>, i: number): CSSProperties => {
    const run = runs[i]
    const r = (on: boolean | undefined) => (on ? '3px' : '0')
    return {
      left: `${item.x * 100}%`,
      // a run of equal marks reads as one stretch (each overlaps the next by a hair, so no seam shows at fractional
      // pixels); 2 px where the fill changes
      width: `max(2px, calc(${item.w * 100}% ${run?.end ? '- 2px' : '+ 1px'}))`,
      borderRadius: `${r(run?.start)} ${r(run?.end)} ${r(run?.end)} ${r(run?.start)}`,
    }
  }

  const nowLine = isToday && <span className="day-strip-now" style={{ left: `${nowX * 100}%` }} aria-hidden="true" />
  const hoursLong = Math.round((end - start) / 3600)
  const title = isToday ? 'Today' : dayLabel(day)

  return (
    <section className="panel day-strip">
      <div className="panel-head">
        <div className="day-strip-title">
          <h2>
            {title}, {what} by {what}
          </h2>
          {head && <span className="day-strip-sub">{head}</span>}
        </div>
        {chips}
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
        <p className="day-strip-intro">
          {dayLabel(day)}, 00:00 to 24:00
          {hoursLong !== 24 && ` (${hoursLong} hours: the clocks go ${hoursLong > 24 ? 'back' : 'forward'})`}.
          {hasItems && ' Point at a stretch, or tab to it, for the details.'}
        </p>
        {!hasItems ? (
          <p className="muted" style={{ margin: 0 }}>
            {empty}
          </p>
        ) : (
          <>
            <div className="day-strip-chart">
              <span className="day-strip-label" aria-hidden="true">
                {rowLabel}
              </span>
              <div className="day-strip-row" ref={mainRow} onPointerLeave={main.leave}>
                <div
                  className="day-strip-track"
                  ref={track}
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
                      data-ahead={item.ahead || undefined}
                      style={{ ...geometry(item, i), background: fillOf(item) }}
                      aria-label={markText(item)}
                      aria-describedby={i === main.shown ? mainId : undefined}
                      title={detail ? undefined : markText(item)}
                      {...main.markProps(i, () => {
                        if (item.runId) navigate(`/runs/${item.runId}`)
                      })}
                    />
                  ))}
                  {segments.map((seg) => {
                    const chip = seg.ink === null
                    const text = segmentText(seg.names, seg.w * width, chip)
                    return (
                      text && (
                        <span
                          key={seg.from}
                          className="day-strip-name"
                          data-chip={chip || undefined}
                          style={{ left: `${seg.x * 100}%`, width: `${seg.w * 100}%`, color: seg.ink ?? undefined }}
                          aria-hidden="true"
                        >
                          <span>{text}</span>
                        </span>
                      )
                    )
                  })}
                  {ticks
                    ?.filter((tick) => tick.t >= start && tick.t < end)
                    .map((tick, i) => (
                      <span
                        key={`${tick.t}-${i}`}
                        className="day-strip-tick"
                        style={{ left: pos(tick.t), background: tick.color }}
                        aria-hidden="true"
                      />
                    ))}
                  {nowLine}
                </div>
                {shownItem && shownDetail && (
                  <StripPopup id={mainId} at={shownItem.x + shownItem.w / 2}>
                    {shownDetail}
                    <PopupFoot marks={main} runId={shownItem.runId} noun={what} />
                  </StripPopup>
                )}
              </div>
              {wrote.length > 0 && (
                <>
                  <span className="day-strip-label" aria-hidden="true">
                    Lens wrote
                  </span>
                  <div className="day-strip-writes" aria-hidden="true">
                    {wrote.map((tick, i) => (
                      <span
                        key={`${tick.t}-${i}`}
                        className="day-strip-write"
                        data-kind={tick.kind}
                        style={{ left: pos(tick.t) }}
                      />
                    ))}
                    {nowLine}
                  </div>
                </>
              )}
              {agree.length > 0 && (
                <>
                  <span className="day-strip-label" aria-hidden="true">
                    Automation
                  </span>
                  <div className="day-strip-row" ref={agreeRow} onPointerLeave={auto.leave}>
                    <div
                      className="day-strip-agree"
                      role="group"
                      aria-label={`Where the automation did the same and where it differed: use the arrow keys to move between them`}
                    >
                      {agree.map((run, i) => {
                        const tone = AGREE_TONES[run.state]
                        const runId = runOf(run)
                        return (
                          <button
                            key={run.x}
                            type="button"
                            className="day-strip-agree-run"
                            data-state={run.state}
                            style={{ left: `${run.x * 100}%`, width: `max(2px, calc(${run.w * 100}% - 2px))` }}
                            aria-label={`${tone.title}, ${formatSpan(at(run.x), at(run.x + run.w), timeZone)}`}
                            aria-describedby={i === auto.shown ? agreeId : undefined}
                            {...auto.markProps(i, () => {
                              if (runId) navigate(`/runs/${runId}`)
                            })}
                          >
                            {labelFits(tone.text, run.w * width) ? tone.text : null}
                          </button>
                        )
                      })}
                      {nowLine}
                    </div>
                    {shownRun && (
                      <StripPopup id={agreeId} at={shownRun.x + shownRun.w / 2}>
                        <AgreePopup
                          run={shownRun}
                          from={at(shownRun.x)}
                          until={at(shownRun.x + shownRun.w)}
                          what={what}
                          timeZone={timeZone}
                          differs={shownRun.items
                            .filter((i) => items[i]?.state === 'differs')
                            .slice(0, DIFFERS_SHOWN)
                            .map((i) => ({ at: clock(items[i]!.x), text: differText?.(items[i]!) ?? null }))}
                        />
                        <PopupFoot marks={auto} runId={runOf(shownRun)} noun="stretch" />
                      </StripPopup>
                    )}
                  </div>
                </>
              )}
              <span className="day-strip-label" aria-hidden="true" />
              <div className="day-strip-axis" aria-hidden="true">
                {hours.map((h) => (
                  <span
                    key={`tick-${h.t}`}
                    className="day-strip-hour"
                    data-major={h.hour % labelEvery === 0 || undefined}
                    style={{ left: pos(h.t) }}
                  />
                ))}
                {hours
                  .filter(
                    (h) =>
                      h.hour % labelEvery === 0 &&
                      (!isToday || Math.abs((h.t - start) / (end - start) - nowX) * width > NOW_CLEAR_PX),
                  )
                  .map((h) => (
                    <span
                      key={`label-${h.t}`}
                      className="day-strip-hour-label"
                      data-edge={h.t === start ? 'start' : h.t === end ? 'end' : undefined}
                      style={{ left: pos(h.t) }}
                    >
                      {h.label}
                    </span>
                  ))}
                {isToday && nowX > 0 && nowX < 1 && (
                  <span className="day-strip-now-tag" style={{ left: `${nowX * 100}%` }}>
                    {formatClock(now.toISOString(), timeZone).slice(0, 5)}
                  </span>
                )}
              </div>
            </div>
            <StripFooterKey
              legend={legend}
              writes={[
                { kind: 'wrote', text: `EMHASS Lens wrote to the ${writes?.target}`, count: written.wrote },
                { kind: 'would', text: 'would write (dry run)', count: written.would },
                { kind: 'held', text: writes?.held ?? 'held', count: written.held },
                { kind: 'noop', text: 'nothing to do', count: written.noop },
              ]}
              agree={agree.length > 0 ? agreed : null}
              planned={items.some((i) => i.ahead)}
            >
              {footer}
            </StripFooterKey>
          </>
        )}
      </div>
    </section>
  )
}
