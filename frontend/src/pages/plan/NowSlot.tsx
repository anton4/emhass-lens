import { useState } from 'react'
import { Link } from 'react-router'
import { usePlanNow } from '../../api/queries'
import type { PlanRow } from '../../api/types'
import { LabelledLamp } from '../../components/Lamp'
import { ErrorNotice } from '../../components/PageHead'
import { formatClock, formatSlot } from '../../lib/format'
import { byKey, chargerText, inverterParts } from '../../lib/planNow'
import { ThisSlot } from './ThisSlot'

/** The plan row in force for this quarter-hour (or the next), each tile with what is measured now, and what the
 * inverter is set to: plan and reality side by side. */
export function NowSlot({ columns, tz, now }: { columns: string[]; tz: string; now: Date }) {
  const planNow = usePlanNow()
  const [next, setNext] = useState(false)
  const d = planNow.data
  const row = (next ? d?.next_row : d?.row) as PlanRow | null | undefined
  const start = next ? d?.next_start : d?.slot_start
  const end = start ? new Date(Date.parse(start) + 15 * 60_000).toISOString() : null
  const measured = byKey(d?.quantities)
  const anyMeasured = (d?.quantities ?? []).some((q) => q.measured !== null && q.measured !== undefined)
  const inv = d?.inverter
  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-title-row">
          <h2>{next ? 'Next slot' : 'This slot'}</h2>
          {start && end && (
            <span className="muted">
              {formatClock(start, tz)}–{formatClock(end, tz)}
              {!next && d?.published_at && <> · published {formatClock(d.published_at, tz)}</>}
            </span>
          )}
        </div>
        {d && (
          <div className="segmented" role="group" aria-label="Which slot">
            <button type="button" aria-pressed={!next} onClick={() => setNext(false)}>
              This slot
            </button>
            <button
              type="button"
              aria-pressed={next}
              onClick={() => setNext(true)}
              title={`From ${formatSlot(d.next_start, now, tz)}`}
            >
              Next slot
            </button>
          </div>
        )}
      </div>
      <div className="panel-body">
        <ErrorNotice error={planNow.error} />
        {row ? (
          <ThisSlot
            row={row}
            columns={columns}
            now={next ? undefined : measured}
            charger={next ? null : chargerText(d?.charger)}
          />
        ) : (
          d && (
            <p className="muted" style={{ margin: 0 }}>
              {next ? 'No stored plan covers the next quarter-hour yet.' : 'No stored plan covers this quarter-hour.'}
            </p>
          )
        )}
        {!next && inv && (
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
        {!next && measured.batt?.sign_hint && (
          <div className="notice" data-color="amber" role="note">
            The battery runs the other way than expected. If your battery sensor counts charging as positive, tick{' '}
            <strong>Opposite sign</strong> under{' '}
            <Link to="/settings?section=measurements">Settings → Measurements → Battery power</Link>.
          </div>
        )}
        {!next &&
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
