import type { PublishEvent } from '../api/types'
import { formatTime } from '../lib/format'
import { batteryText, gridText, kwText } from '../lib/publish'

/** The values of a plan-published event, with EMHASS's signs spelled out. */
export function PublishEventView({ event, timeZone }: { event: PublishEvent; timeZone?: string }) {
  const c = event.current ?? {}
  return (
    <>
      <p className="cell-sub" style={{ marginTop: 0 }}>
        Slot {formatTime(event.slot_start, new Date(), timeZone)} – {formatTime(event.slot_end, new Date(), timeZone)}, from
        the plan of {formatTime(event.plan_generated_at, new Date(), timeZone)}
      </p>
      <dl className="event-values">
        <div>
          <dt>Battery</dt>
          <dd>{batteryText(c.p_batt_w)}</dd>
          <div className="cell-sub">P_batt {c.p_batt_w ?? '—'} W (+ discharge, − charge)</div>
        </div>
        <div>
          <dt>Grid</dt>
          <dd>{gridText(c.p_grid_w)}</dd>
          <div className="cell-sub">P_grid {c.p_grid_w ?? '—'} W (+ import, − export)</div>
        </div>
        <div>
          <dt>PV</dt>
          <dd>{kwText(c.p_pv_w)}</dd>
          {c.p_pv_curtailment_w ? <div className="cell-sub">curtailed {kwText(c.p_pv_curtailment_w)}</div> : null}
        </div>
        <div>
          <dt>Battery SOC</dt>
          <dd>{typeof c.soc_opt === 'number' ? `${(c.soc_opt * 100).toFixed(1)} %` : '—'}</dd>
          <div className="cell-sub">planned SOC_opt for this slot</div>
        </div>
        {typeof c.p_deferrable0_w === 'number' && (
          <div>
            <dt>Deferrable load</dt>
            <dd>{kwText(c.p_deferrable0_w)}</dd>
          </div>
        )}
        {event.price && (
          <div>
            <dt>Price</dt>
            <dd>{(event.price.import * 100).toFixed(2)} c</dd>
            <div className="cell-sub">import, export {(event.price.export * 100).toFixed(2)} c/kWh</div>
          </div>
        )}
      </dl>
    </>
  )
}
