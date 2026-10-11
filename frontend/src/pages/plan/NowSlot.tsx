import { useState } from 'react'
import { Link } from 'react-router'
import { usePlanNow } from '../../api/queries'
import type { PlanRow } from '../../api/types'
import { LabelledLamp } from '../../components/Lamp'
import { ErrorNotice } from '../../components/PageHead'
import { formatClock, formatSlot } from '../../lib/format'
import { byKey, chargerText, inverterParts } from '../../lib/planNow'
import { ThisSlot } from './ThisSlot'

type Which = 'prev' | 'now' | 'next'
const TITLE: Record<Which, string> = { prev: 'Previous slot', now: 'This slot', next: 'Next slot' }
const NO_PLAN: Record<Which, string> = {
  prev: 'No stored plan covers the previous quarter-hour.',
  now: 'No stored plan covers this quarter-hour.',
  next: 'No stored plan covers the next quarter-hour yet.',
}

/** The plan row in force for this quarter-hour (or the previous or next one), each tile with what is measured (now,
 * or the quarter-hour mean for the slot that has ended), and what the inverter is set to: plan and reality side by
 * side. */
export function NowSlot({ columns, tz, now }: { columns: string[]; tz: string; now: Date }) {
  const planNow = usePlanNow()
  const [which, setWhich] = useState<Which>('now')
  const d = planNow.data
  const row = (which === 'prev' ? d?.prev_row : which === 'next' ? d?.next_row : d?.row) as PlanRow | null | undefined
  const start = which === 'prev' ? d?.prev_start : which === 'next' ? d?.next_start : d?.slot_start
  const end = start ? new Date(Date.parse(start) + 15 * 60_000).toISOString() : null
  const quantities = which === 'prev' ? d?.prev_quantities : which === 'now' ? d?.quantities : undefined
  const measured = byKey(quantities)
  const anyMeasured = (quantities ?? []).some((q) => q.measured !== null && q.measured !== undefined)
  const anySensor = (quantities ?? []).some((q) => q.entity)
  const inv = d?.inverter
  const isNow = which === 'now'
  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-title-row">
          <h2>{TITLE[which]}</h2>
          {start && end && (
            <span className="muted">
              {formatClock(start, tz)}–{formatClock(end, tz)}
              {isNow && d?.published_at && <> · published {formatClock(d.published_at, tz)}</>}
            </span>
          )}
        </div>
        {d && (
          <div className="segmented" role="group" aria-label="Which slot">
            {(['prev', 'now', 'next'] as const).map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={which === w}
                onClick={() => setWhich(w)}
                title={w === 'now' ? undefined : `From ${formatSlot(w === 'prev' ? d.prev_start : d.next_start, now, tz)}`}
              >
                {TITLE[w]}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="panel-body">
        <ErrorNotice error={planNow.error} />
        {row ? (
          <ThisSlot
            row={row}
            columns={columns}
            now={which === 'next' ? undefined : measured}
            charger={isNow ? chargerText(d?.charger) : null}
            past={which === 'prev'}
          />
        ) : (
          d && (
            <p className="muted" style={{ margin: 0 }}>
              {NO_PLAN[which]}
            </p>
          )
        )}
        {isNow && inv && (
          <div className="inverter-strip">
            <LabelledLamp
              color={inv.in_control ? 'green' : 'amber'}
              text={inv.in_control ? 'Inverter set to' : 'Inverter not in control'}
            />
            {inv.in_control ? (
              inverterParts(inv).map((part) => <span key={part}>{part}</span>)
            ) : (
              <span>{inv.reason}</span>
            )}
            {inv.written_at && (
              <span className="muted">
                written {formatClock(inv.written_at, tz)}
                {inv.run_id && (
                  <>
                    {' · '}
                    <Link to={`/runs/${inv.run_id}`}>run #{inv.run_id}</Link>
                  </>
                )}
              </span>
            )}
          </div>
        )}
        {which !== 'next' && measured.batt?.sign_hint && (
          <div className="notice" data-color="amber" role="note">
            The battery runs the other way than expected. If your battery sensor counts charging as positive, tick{' '}
            <strong>Opposite sign</strong> under{' '}
            <Link to="/settings?section=measurements">Settings → Measurements → Battery power</Link>.
          </div>
        )}
        {which === 'prev' && row && anySensor && (
          <p className="chart-note">
            {anyMeasured
              ? 'Measured: the quarter-hour means of your sensors, judged like this slot; the SoC against the middle ' +
                'of the planned range.'
              : 'The measured quarter-hour means appear shortly after the slot ends, once they are read from the ' +
                'Home Assistant recorder.'}
          </p>
        )}
        {isNow &&
          row &&
          (anyMeasured ? (
            <details className="chart-note more">
              <summary>How “now” is judged</summary>
              “now” comes from the sensors under{' '}
              <Link to="/settings?section=measurements">Settings → Measurements</Link>. House load and PV are forecasts
              and aren't judged. The battery is compared with what the plan means for the load and PV now, the grid with
              the plan; an amber mark means a difference of more than 300 W and 15 % (SoC: 2 points from where the plan
              expects it now).
            </details>
          ) : (
            <p className="chart-note">
              Name your battery, grid, PV and load sensors under{' '}
              <Link to="/settings?section=measurements">Settings → Measurements</Link> to see what happens now next to
              the plan.
            </p>
          ))}
      </div>
    </section>
  )
}
