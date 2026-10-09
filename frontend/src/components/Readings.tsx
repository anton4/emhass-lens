import type { DeferrableDescription, InputsSnapshot, Reading } from '../api/types'
import { formatTime } from '../lib/format'
import { formatAge, formatFraction, isNumber } from '../lib/units'
import { Lamp } from './Lamp'

/** A value EMHASS gets from Home Assistant, with where it came from and how old it is. */
export function ReadingCard({ title, reading, kind = 'fraction' }: { title: string; reading: Reading; kind?: 'fraction' | 'number' | 'bool' }) {
  const failed = reading.value === null
  const fallback = !failed && reading.source === 'default'
  const shown =
    reading.value === null
      ? 'No value'
      : kind === 'bool'
        ? reading.value
          ? 'On'
          : 'Off'
        : kind === 'fraction' && isNumber(reading.value)
          ? formatFraction(reading.value)
          : String(reading.value)
  return (
    <div className="card">
      <div className="card-title">
        <Lamp color={failed ? 'red' : fallback || reading.issue ? 'amber' : 'green'} />
        {title}
      </div>
      <div className="card-value">{shown}</div>
      <div className="cell-sub">
        {reading.source === 'default' ? 'default value' : <code>{reading.source}</code>}
        {reading.age_s !== null && <> · {formatAge(reading.age_s)} old</>}
      </div>
      {reading.issue && (
        <div className="card-issue" data-color={failed ? 'red' : 'amber'}>
          {reading.issue}
        </div>
      )}
      <details className="card-explain">
        <summary>How it was read</summary>
        {reading.explain}
      </details>
    </div>
  )
}

function DeferrableCard({ load }: { load: DeferrableDescription }) {
  const on = load.enabled.value === true
  const issues = [load.enabled, load.operating_hours, load.deadline_timesteps, load.single_constant].filter(
    (r) => r.issue,
  )
  return (
    <div className="card">
      <div className="card-title">
        <Lamp color={issues.length ? 'amber' : on ? 'green' : 'neutral'} />
        {load.name}
      </div>
      <div className="card-value">{on ? `${(load.nominal_power_w / 1000).toFixed(1)} kW` : 'Off'}</div>
      <div className="cell-sub">
        <code>{load.enabled.source}</code>
      </div>
      <dl className="mini-facts">
        <div>
          <dt>Enabled</dt>
          <dd>{on ? 'on' : 'off'}</dd>
        </div>
        <div>
          <dt>Operating hours</dt>
          <dd>{String(load.operating_hours.value ?? '—')}</dd>
        </div>
        <div>
          <dt>Deadline</dt>
          <dd>{isNumber(load.deadline_timesteps.value) && load.deadline_timesteps.value > 0 ? `${load.deadline_timesteps.value} steps` : 'none'}</dd>
        </div>
        <div>
          <dt>One block</dt>
          <dd>{load.single_constant.value ? 'yes' : 'no'}</dd>
        </div>
      </dl>
      {issues.map((r) => (
        <div key={r.name} className="card-issue" data-color="amber">
          {r.name.replace(/_/g, ' ')}: {r.issue}
        </div>
      ))}
    </div>
  )
}

/** The inputs an MPC run used (or would use now). */
export function InputsView({ snapshot }: { snapshot: InputsSnapshot }) {
  const pv = snapshot.pv
  return (
    <>
      <div className="cards">
        <ReadingCard title="Battery SOC now" reading={snapshot.soc_init} />
        <ReadingCard title="Target SOC at the end" reading={snapshot.soc_final} />
        {snapshot.deferrable_loads.map((load) => (
          <DeferrableCard key={load.name} load={load} />
        ))}
        <div className="card">
          <div className="card-title">
            <Lamp color={snapshot.prices.slots === 0 ? 'red' : 'green'} />
            Prices
          </div>
          <div className="card-value">{snapshot.prices.slots} slots</div>
          <div className="cell-sub">
            {snapshot.prices.actual} from Nord Pool, {snapshot.prices.forecast} forecast
          </div>
          <div className="cell-sub">
            {formatTime(snapshot.prices.first)} → {formatTime(snapshot.prices.end)}
          </div>
        </div>
        <div className="card">
          <div className="card-title">
            <Lamp color={!pv ? 'neutral' : pv.sensors_used.length === 0 || pv.slots_missing > 0 ? 'amber' : 'green'} />
            PV forecast
          </div>
          {pv ? (
            <>
              <div className="card-value">{pv.slots_missing === 0 ? 'Complete' : `${pv.slots_missing} slots missing`}</div>
              <div className="cell-sub">
                Solcast {pv.field}, {pv.sensors_used.length} day sensors
              </div>
              {pv.sensors_used.length === 0 && pv.sensors_missing.length > 0 ? (
                <div className="card-issue" data-color="amber">
                  None of the {pv.sensors_missing.length} Solcast day sensors was found (e.g.{' '}
                  <code>{pv.sensors_missing[0]}</code>)
                </div>
              ) : pv.sensors_missing.length > 0 ? (
                <div className="card-issue" data-color="amber">
                  Missing: {pv.sensors_missing.join(', ')}
                </div>
              ) : null}
              {pv.first_missing && <div className="cell-sub">First gap at {formatTime(pv.first_missing)}</div>}
            </>
          ) : (
            <div className="card-value">Off</div>
          )}
        </div>
      </div>
    </>
  )
}
