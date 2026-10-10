import type { RunSummary } from '../api/types'
import { formatClock, formatDuration, formatSlot } from '../lib/format'
import { OUTCOMES, outcomeLabel } from '../lib/outcomes'
import { LANES, axisTicks, laneOf } from '../lib/runLanes'

const W = 1000

/** The listed runs as marks on one time axis, a lane per kind of job, coloured by outcome. A mark is as wide as the
 *  run took (at least a hairline); a click picks the run. The list under it stays the accessible way to a run. */
export function RunTimeline({
  runs,
  from,
  to,
  timeZone,
  jobTitle,
  selected,
  onPick,
}: {
  runs: RunSummary[]
  from: number
  to: number
  timeZone?: string
  jobTitle: (job: string) => string
  selected?: number | null
  onPick: (run: RunSummary) => void
}) {
  if (runs.length === 0 || !(to > from)) return null
  const x = (t: number) => ((t - from) / (to - from)) * W
  const lanes = LANES.map((lane) => ({ lane, runs: runs.filter((r) => laneOf(r.job) === lane) })).filter(
    (l) => l.runs.length > 0,
  )
  const now = new Date(to * 1000)
  return (
    <div className="run-timeline">
      {lanes.map(({ lane, runs: these }) => (
        <div key={lane} className="run-lane">
          <span className="run-lane-name">{lane}</span>
          <svg viewBox={`0 0 ${W} 20`} preserveAspectRatio="none" aria-hidden="true">
            {these.map((r) => {
              const start = Date.parse(r.started_at) / 1000
              const left = x(start)
              const width = Math.max(2.5, x(start + (r.duration_ms ?? 0) / 1000) - left)
              const color = OUTCOMES[r.outcome]?.color ?? 'neutral'
              return (
                <rect
                  key={r.id}
                  x={Math.min(left, W - width)}
                  y={4}
                  width={width}
                  height={12}
                  rx={1}
                  className="run-mark"
                  data-selected={r.id === selected || undefined}
                  style={{ fill: `var(--lamp-${color})` }}
                  onClick={() => onPick(r)}
                >
                  <title>
                    {`Run ${r.id} · ${jobTitle(r.job)} · ${formatClock(r.started_at, timeZone)} · ${outcomeLabel(r.outcome)}${
                      r.duration_ms ? ` · ${formatDuration(r.duration_ms)}` : ''
                    }`}
                  </title>
                </rect>
              )
            })}
          </svg>
        </div>
      ))}
      <div className="run-lane run-axis" aria-hidden="true">
        <span />
        <div>
          {axisTicks(from, to).map((t) => {
            const pct = (x(t) / W) * 100
            // labels at the edges hang inwards instead of past the strip
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
  )
}
