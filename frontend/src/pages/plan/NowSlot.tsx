import { useState } from 'react'
import { Link } from 'react-router'
import { usePlanNow } from '../../api/queries'
import type { PlanPrice, PlanRow } from '../../api/types'
import { ErrorNotice } from '../../components/PageHead'
import { formatClock, formatSlot } from '../../lib/format'
import { byKey } from '../../lib/planNow'
import { ThisSlot } from './ThisSlot'

type Which = 'prev' | 'now' | 'next'
const TITLE: Record<Which, string> = { prev: 'Previous slot', now: 'This slot', next: 'Next slot' }
const NO_PLAN: Record<Which, string> = {
  prev: 'No stored plan covers the previous quarter-hour.',
  now: 'No stored plan covers this quarter-hour.',
  next: 'No stored plan covers the next quarter-hour yet.',
}

/** The plan row in force for this quarter-hour (or the previous or next one) as a flow: what is measured now (or the
 *  quarter-hour means for the slot that has ended) with the plan under it, and what the inverter is set to. */
export function NowSlot({
  columns,
  prices,
  tz,
  now,
}: {
  columns: string[]
  prices: PlanPrice[]
  tz: string
  now: Date
}) {
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
  const isNow = which === 'now'
  const fetchedAt = planNow.dataUpdatedAt
  // the state of charge starts where the slot before ended
  const fromRow = (which === 'now' ? d?.prev_row : which === 'next' ? d?.row : undefined) as PlanRow | null | undefined
  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-title-row">
          <h2>{TITLE[which]}</h2>
          {start && end && (
            <span className="muted">
              {formatClock(start, tz)}–{formatClock(end, tz)}
              {isNow && d?.published_at && <> · published {formatClock(d.published_at, tz)}</>}
              {which === 'prev' && anyMeasured && <> · quarter-hour means</>}
              {isNow && fetchedAt > 0 && (
                <span title="When this page last read the sensors, the plan and the inverter; it reads them every 10 s">
                  {' '}
                  · read {formatClock(new Date(fetchedAt).toISOString(), tz)}
                </span>
              )}
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
        {row && start ? (
          <ThisSlot
            row={row}
            fromRow={fromRow}
            columns={columns}
            now={which === 'next' ? undefined : measured}
            past={which === 'prev'}
            charger={isNow ? d?.charger : null}
            inverter={isNow ? d?.inverter : null}
            plan={isNow ? { generatedAt: d?.plan_generated_at ?? null, runId: d?.plan_run_id ?? null } : undefined}
            socMin={d?.soc_min}
            socMax={d?.soc_max}
            prices={prices}
            slotStart={start}
            fetchedAt={fetchedAt}
            tz={tz}
          />
        ) : (
          d && (
            <p className="muted" style={{ margin: 0 }}>
              {NO_PLAN[which]}
            </p>
          )
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
              The big numbers come from the sensors under{' '}
              <Link to="/settings?section=measurements">Settings → Measurements</Link>, the plan is the line under
              them, and the time next to a name is how long ago that sensor last changed. House load and PV are
              forecasts and aren't judged; one that missed by 300 W or more is blue. The battery and the grid are
              compared with where the inverter's settings put them with the load and PV now (in PV export the battery
              may not charge, so extra PV goes to the grid), shown as <em>expected</em> when that is off the plan;
              without inverter control the grid is compared with the plan and the battery takes the difference. An
              amber mark means a difference of more than 300 W and 15 % (SoC: 2 points from where the plan expects it
              now). A blue chip at the top means all of it does what is expected and says which forecasts moved it off
              the plan. The EV's power is its charger's current limit while it charges.
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
