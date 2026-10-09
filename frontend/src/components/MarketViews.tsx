import type { MarketSession, MarketSettings, WearStats } from '../api/types'
import { marketGuards, sessionText, type MarketDecision, type MarketSensors } from '../lib/market'
import { formatTime } from '../lib/format'
import { Lamp, LabelledLamp } from './Lamp'

const ACTION: Record<string, { color: 'green' | 'blue' | 'amber' | 'red' | 'neutral'; text: string }> = {
  buy: { color: 'blue', text: 'Buy (force charge)' },
  sell: { color: 'green', text: 'Sell (force discharge)' },
  end: { color: 'amber', text: 'Session end' },
  none: { color: 'neutral', text: 'No action' },
}

export function ActionChip({ action }: { action: string }) {
  const spec = ACTION[action] ?? ACTION.none!
  return (
    <span className="chip" data-color={spec.color}>
      <Lamp color={spec.color} />
      {spec.text}
    </span>
  )
}

/** A market decision: the command, what it sets (or would set), and the throttle reasoning. */
export function MarketDecisionView({ decision, sessionBefore }: { decision: MarketDecision; sessionBefore?: string | null }) {
  const t = decision.targets
  return (
    <>
      <div className="decision-head">
        <ActionChip action={decision.action} />
        <div>
          <div className="cell-title">{decision.message}</div>
          <div className="cell-sub">
            {decision.why}
            {sessionBefore !== undefined && ` · session before: ${sessionBefore ?? 'none'}`}
          </div>
        </div>
      </div>
      {t && (
        <div className="table-wrap">
          <table className="decision-table">
            <thead>
              <tr>
                <th>Setting</th>
                <th>Target</th>
                <th>Written</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Passive state</td>
                <td>{t.state}</td>
                <td rowSpan={4}>{decision.needs_update ? 'yes' : decision.throttle.cooldown_block ? 'no (cooldown)' : 'no (within the deadband or unchanged)'}</td>
              </tr>
              <tr>
                <td>Grid power</td>
                <td className="num">{t.grid_power_w} W</td>
              </tr>
              <tr>
                <td>Battery min</td>
                <td className="num">{t.battery_min_w} W</td>
              </tr>
              <tr>
                <td>Battery max</td>
                <td className="num">{t.battery_max_w} W</td>
              </tr>
              {decision.feedin_w !== null && (
                <tr>
                  <td>
                    Feed-in max
                    <div className="cell-sub">{decision.feedin_why}</div>
                  </td>
                  <td className="num">{decision.feedin_w} W</td>
                  <td>{decision.feedin_write ? 'yes' : 'no'}</td>
                </tr>
              )}
              {decision.session_after !== undefined && (
                <tr>
                  <td>Session select · EMHASS automation switch</td>
                  <td>
                    {decision.session_after ?? 'none'} · {decision.enable_boolean_after ?? 'unchanged'}
                  </td>
                  <td>{decision.action === 'none' ? 'no' : 'yes'}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {decision.throttle.reasons.length > 0 && (
        <>
          <h3 className="sub-head">Why</h3>
          <ul className="cell-sub" style={{ margin: 0 }}>
            {decision.throttle.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </>
      )}
      {decision.notify && (
        <p className="cell-sub">
          Phone message: “{decision.notify}”
        </p>
      )}
    </>
  )
}

/** The live command from Qilowatt and the session the automation (or the App) keeps. */
export function CommandFacts({ sensors, session, tz }: { sensors: MarketSensors | undefined; session: MarketSession | null | undefined; tz?: string }) {
  return (
    <dl className="facts">
      <div>
        <dt>Command</dt>
        <dd>
          {sensors?.source ?? '—'} {sensors?.mode ?? ''} {sensors?.powerlimit_w !== null && sensors?.powerlimit_w !== undefined ? `${Math.round(sensors.powerlimit_w)} W` : ''}
          {sensors?.settle_pending && <div className="cell-sub">settling…</div>}
        </dd>
      </div>
      <div>
        <dt>App session</dt>
        <dd>
          {session ? (
            <>
              <LabelledLamp color={session.direction === 'sell' ? 'green' : 'blue'} text={sessionText(session)} />
              <div className="cell-sub">since {formatTime(session.started_at, new Date(), tz)}</div>
            </>
          ) : (
            'none'
          )}
        </dd>
      </div>
      <div>
        <dt>Home Assistant</dt>
        <dd>
          session select {sensors?.ha_session ?? '—'}
          <div className="cell-sub">EMHASS automation switch {sensors?.enable_boolean ?? '—'}</div>
        </dd>
      </div>
      <div>
        <dt>Battery · PV</dt>
        <dd>
          {sensors?.soc_pct !== null && sensors?.soc_pct !== undefined ? `${Math.round(sensors.soc_pct)} %` : '—'} ·{' '}
          {sensors?.pv_w !== null && sensors?.pv_w !== undefined ? `${Math.round(sensors.pv_w)} W` : '—'}
        </dd>
      </div>
    </dl>
  )
}

/** Presses of the Sofar apply and feed-in buttons: every one wears the EEPROM. */
export function WearFacts({ day, week }: { day: WearStats | undefined; week: WearStats | undefined }) {
  const line = (w: WearStats | undefined) =>
    w ? `${w.apply_presses} apply, ${w.feedin_presses} feed-in (${w.our_commits} by EMHASS Lens${w.presses_not_ours ? `, ${w.presses_not_ours} not ours` : ''})` : '—'
  return (
    <>
      <div>
        <dt>Inverter writes, 24 h</dt>
        <dd>{line(day)}</dd>
      </div>
      <div>
        <dt>Inverter writes, 7 days</dt>
        <dd>{line(week)}</dd>
      </div>
    </>
  )
}

export function MarketExplainer({ thresholds }: { thresholds: MarketSettings['thresholds'] | undefined }) {
  return (
    <details className="explain-details rules-explainer">
      <summary>
        <h3 className="sub-head" style={{ display: 'inline' }}>
          How sessions are run
        </h3>
      </summary>
      <p>
        A Kratt or Fusebox activation arrives through Qilowatt as a source, a command and a power limit. On every change
        (after a short settle time), every minute and at start-up, the wanted inverter state is derived from the current
        values and reconciled with the registers, exactly like the Home Assistant automation "Qilowatt: Master Market
        Controller". Every press of the inverter's apply button wears its EEPROM, so three guards suppress writes that
        aren't worth it:
      </p>
      <ol className="rules-list">
        {marketGuards(thresholds).map((g) => (
          <li key={g.title}>
            <div className="cell-title">{g.title}</div>
            <div>{g.text}</div>
          </li>
        ))}
      </ol>
      <h3 className="sub-head">Modes</h3>
      <ul>
        <li>
          <strong>Off</strong>: nothing is watched. "Reconcile now" still shows what it would do.
        </li>
        <li>
          <strong>Shadow</strong>: every decision is recorded with its reasoning, and a few seconds later the session
          select, the EMHASS automation switch and the inverter registers are read to see whether the automation did the
          same. The App's session follows the automation's select. Nothing is written.
        </li>
        <li>
          <strong>Live</strong>: the App runs the sessions: it keeps the session select and the EMHASS automation switch
          like the automation does, writes feed-in first and the passive-mode registers after, and when a session ends
          it hands the inverter straight back to the plan with one write (the automation's safe state only when no fresh
          plan exists). Sessions survive a restart. "End session now" is the kill switch.
        </li>
      </ul>
      <p className="cell-sub">
        Moving over: run Shadow for at least a week with real sessions and an agreement of 99 % or more, then, with no
        session open, turn the Home Assistant automation off (set it as the interlock) and switch to Live. Going back:
        mode Off, automation on; the mirrored select and switch let it carry on.
      </p>
    </details>
  )
}
