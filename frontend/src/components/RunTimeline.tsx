import { useMemo } from 'react'
import { useRunTimeline } from '../api/queries'
import { formatClock, formatSlot } from '../lib/format'
import { OUTCOMES, outcomeLabel } from '../lib/outcomes'
import {
  TIMELINE_WINDOWS,
  axisTicks,
  timelineBounds,
  timelineCells,
  type CellColor,
  type TimelineWindow,
} from '../lib/runLanes'
import { Lamp } from './Lamp'
import { ErrorNotice } from './PageHead'
import { useNow } from './useNow'

/** Each bar is a bucket's width less this gap, in tenths of a bucket. */
const UNIT = 10
const GAP = 2.5

const LEGEND: { color: CellColor; text: string }[] = [
  { color: 'green', text: 'OK' },
  { color: 'blue', text: 'Dry run or shadow' },
  { color: 'amber', text: 'Refused, differences or missed' },
  { color: 'neutral', text: 'Nothing to do' },
  { color: 'red', text: 'Error' },
]

function colorOf(outcome: string): CellColor {
  return OUTCOMES[outcome]?.color ?? 'neutral'
}

/** Every job's runs in the last hour, 6 hours or 24 hours as bars on one time axis: a lane per kind of job, a bar
 *  per minute, 5 or 15 minutes, coloured by the most notable outcome in it. A click opens that run. The list
 *  under it stays the accessible way to a run. */
export function RunTimeline({
  window,
  onWindow,
  timeZone,
  onPick,
}: {
  window: TimelineWindow
  onWindow: (window: TimelineWindow) => void
  timeZone?: string
  onPick: (runId: number) => void
}) {
  const now = useNow(15_000)
  const nowS = now.getTime() / 1000
  const { from, to, count } = timelineBounds(window, nowS)
  const bucketS = TIMELINE_WINDOWS[window].bucketS
  const timeline = useRunTimeline(new Date(from * 1000).toISOString(), new Date(to * 1000).toISOString(), bucketS)
  const { lanes, totals } = useMemo(
    () => timelineCells(timeline.data?.cells ?? [], count, colorOf),
    [timeline.data, count],
  )
  const clock = (t: number) => formatClock(new Date(t * 1000).toISOString(), timeZone).slice(0, 5)
  const nowX = ((nowS - from) / (to - from)) * 100
  const width = count * UNIT

  return (
    <section className="panel run-timeline-panel">
      <div className="panel-head">
        <h2>Timeline</h2>
        <span className="run-timeline-legend">
          {LEGEND.filter((l) => totals[l.color] > 0).map((l) => (
            <span key={l.color} className="labelled-lamp">
              <Lamp color={l.color} />
              {l.text} {totals[l.color]}
            </span>
          ))}
        </span>
        <div className="segmented" role="group" aria-label="How far back the timeline reaches">
          {(Object.keys(TIMELINE_WINDOWS) as TimelineWindow[]).map((w) => (
            <button key={w} type="button" aria-pressed={w === window} onClick={() => onWindow(w)}>
              {TIMELINE_WINDOWS[w].label}
            </button>
          ))}
        </div>
      </div>
      <ErrorNotice error={timeline.error} />
      {timeline.isSuccess && lanes.length === 0 ? (
        <p className="muted run-timeline-empty">No runs in the last {TIMELINE_WINDOWS[window].label}.</p>
      ) : (
        <div className="run-timeline">
          {lanes.map(({ lane, cells }) => (
            <div key={lane} className="run-lane">
              <span className="run-lane-name">{lane}</span>
              <div className="run-lane-bars">
                <svg viewBox={`0 0 ${width} 20`} preserveAspectRatio="none" aria-hidden="true">
                  {cells.map((cell) => {
                    if (!cell) return null
                    const start = from + cell.bucket * bucketS
                    return (
                      <rect
                        key={cell.bucket}
                        x={cell.bucket * UNIT + GAP / 2}
                        y={3}
                        width={UNIT - GAP}
                        height={14}
                        className="run-bar"
                        style={{ fill: `var(--lamp-${cell.color})` }}
                        onClick={() => onPick(cell.runId)}
                      >
                        <title>
                          {`${clock(start)}–${clock(start + bucketS)} · ${lane} · ${cell.counts
                            .map((c) => `${c.count} ${outcomeLabel(c.outcome)}`)
                            .join(' · ')}`}
                        </title>
                      </rect>
                    )
                  })}
                </svg>
                <span className="run-lane-now" style={{ left: `${nowX}%` }} aria-hidden="true" />
              </div>
            </div>
          ))}
          <div className="run-lane run-axis" aria-hidden="true">
            <span />
            <div>
              {axisTicks(from, to).map((t) => {
                const pct = ((t - from) / (to - from)) * 100
                const shift = pct > 92 ? 'translateX(-100%)' : pct < 6 ? 'none' : undefined
                return (
                  <span key={t} style={{ left: `${pct}%`, transform: shift }}>
                    {formatSlot(new Date(t * 1000).toISOString(), now, timeZone)}
                  </span>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
