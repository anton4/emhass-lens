import { Link } from 'react-router'
import { useOutputs } from '../../api/queries'
import { JsonViewer } from '../../components/JsonViewer'
import { LabelledLamp } from '../../components/Lamp'
import { ErrorNotice } from '../../components/PageHead'
import { formatTime } from '../../lib/format'
import { PublishEventView } from '../../components/PublishEventView'

/** What EMHASS Lens gives Home Assistant: MQTT entities and the plan-published event. */
export function OutputsCard() {
  const outputs = useOutputs()
  const o = outputs.data
  const mqtt = !o
    ? { color: 'neutral' as const, text: 'Checking…' }
    : !o.enabled
      ? { color: 'neutral' as const, text: 'MQTT entities off' }
      : o.connected
        ? { color: 'green' as const, text: 'MQTT connected' }
        : { color: 'amber' as const, text: 'MQTT not connected' }
  const event = o?.last_event ?? null

  return (
    <section id="card-outputs" className="panel">
      <div className="panel-head">
        <h2>Home Assistant outputs</h2>
        <Link to="/settings?section=outputs">Settings → Home Assistant outputs</Link>
      </div>
      <div className="panel-body">
        <ErrorNotice error={outputs.error} />
        <dl className="facts">
          <div>
            <dt>MQTT entities</dt>
            <dd>
              <LabelledLamp color={mqtt.color} text={mqtt.text} />
              {o?.enabled && (
                <div className="cell-sub">
                  broker {o.broker ?? '—'}
                  {o.last_error && <> · {o.last_error}</>}
                </div>
              )}
            </dd>
          </div>
          <div>
            <dt>Last plan published</dt>
            <dd>{formatTime(o?.last_published_at)}</dd>
          </div>
        </dl>
        <p className="cell-sub">
          {o?.enabled
            ? 'The EMHASS Lens device in Home Assistant has the import and export price now, a problem sensor, the last successful MPC, an Auto MPC switch and a Run MPC button.'
            : 'With MQTT entities on, an "EMHASS Lens" device appears in Home Assistant (needs the Mosquitto broker App).'}
        </p>
        <h3>The plan-published event</h3>
        <p className="cell-sub">
          In live mode, right after each slot starts, EMHASS Lens calls EMHASS publish-data and then fires{' '}
          <code>emhass_lens_plan_published</code> with that slot's plan values. An automation can trigger on it instead of
          on a fixed second after the quarter-hour, and read the values from <code>trigger.event.data.current</code>.
        </p>
        {event ? (
          <>
            <PublishEventView event={event} />
            <details>
              <summary>Event data</summary>
              <JsonViewer value={event} />
            </details>
          </>
        ) : (
          <p className="muted" style={{ marginBottom: 0 }}>
            No event since EMHASS Lens started (it only publishes in live mode while it drives EMHASS).
          </p>
        )}
      </div>
    </section>
  )
}
