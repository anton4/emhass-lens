import { useMemo } from 'react'
import { useNavigate } from 'react-router'
import { shiftDay, todayKey, zonedTime } from '../../lib/days'
import { stripCounts, stripItems, stripLabels, type StripInput, type StripState } from '../../lib/dayStrip'
import { formatClock } from '../../lib/format'
import { Lamp } from '../Lamp'
import { useNow } from '../useNow'

const W = 1000

const FILL: Record<StripState, string> = {
  same: 'var(--lamp-green)',
  differs: 'var(--lamp-amber)',
  none: 'var(--line-neutral)',
}

const STATE_TEXT: Record<StripState, string> = {
  same: 'same as the automation',
  differs: 'the automation differed',
  none: 'not compared',
}

/** Today's decisions on a 00–24 axis: green where the automation did the same, amber where it differed, grey where
 *  nothing was compared; the rule is named where it changes, and a click opens the decision. */
export function DayStrip({
  inputs,
  span,
  timeZone,
  what = 'slot',
  empty,
}: {
  inputs: StripInput[]
  /** How long one decision holds, in seconds (a slot: 900). */
  span: number
  timeZone?: string
  what?: 'slot' | 'decision'
  /** Shown when nothing was decided today. */
  empty: string
}) {
  const navigate = useNavigate()
  const now = useNow(60_000)
  const day = todayKey(timeZone, now)
  const start = zonedTime(day, 0, 0, timeZone).getTime() / 1000
  const end = zonedTime(shiftDay(day, 1), 0, 0, timeZone).getTime() / 1000
  const items = useMemo(() => stripItems(inputs, start, end, span), [inputs, start, end, span])
  const labels = stripLabels(items)
  const counts = stripCounts(items)
  const nowX = Math.min(1, Math.max(0, (now.getTime() / 1000 - start) / (end - start)))
  const clock = (x: number) =>
    formatClock(new Date((start + x * (end - start)) * 1000).toISOString(), timeZone).slice(0, 5)

  return (
    <section className="panel day-strip">
      <div className="panel-head">
        <h2>
          Today, {what} by {what}
        </h2>
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
      </div>
      <div className="panel-body">
        {items.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {empty}
          </p>
        ) : (
          <div className="day-strip-chart">
            <div className="day-strip-labels" aria-hidden="true">
              {labels.map((l) => (
                <span
                  key={`${l.x}-${l.text}`}
                  className={l.x > 0.8 ? 'day-strip-label-end' : undefined}
                  style={l.x > 0.8 ? { right: `${(1 - l.x) * 100}%` } : { left: `${l.x * 100}%` }}
                >
                  {l.text}
                </span>
              ))}
            </div>
            <svg
              viewBox={`0 0 ${W} 28`}
              preserveAspectRatio="none"
              role="img"
              aria-label={`Today: ${counts.same} ${what}s the same as the automation, ${counts.differs} different, ${counts.none} not compared`}
            >
              <rect x={0} y={4} width={W} height={20} style={{ fill: 'var(--surface-sunk)' }} />
              {items.map((item) => (
                <rect
                  key={item.x}
                  x={item.x * W}
                  y={4}
                  width={Math.max(1.2, item.w * W - 0.8)}
                  height={20}
                  className={item.runId ? 'day-strip-mark' : undefined}
                  style={{ fill: FILL[item.state] }}
                  onClick={() => item.runId && navigate(`/runs/${item.runId}`)}
                >
                  <title>{`${clock(item.x)}${item.label ? ` · ${item.label}` : ''} · ${STATE_TEXT[item.state]}`}</title>
                </rect>
              ))}
              <line x1={nowX * W} x2={nowX * W} y1={0} y2={28} className="day-strip-now" />
            </svg>
            <div className="day-strip-axis" aria-hidden="true">
              {[0, 0.25, 0.5, 0.75, 1].map((x) => (
                <span key={x} style={{ left: `${x * 100}%` }}>
                  {x === 1 ? '24:00' : clock(x)}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
