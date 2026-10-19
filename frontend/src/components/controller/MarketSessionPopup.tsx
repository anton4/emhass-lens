import { formatSpan } from '../../lib/dayStrip'
import { NO_SETTINGS_FILL, marketFill } from '../../lib/inverter'
import { sessionCompared, sessionName, sessionRows, type SessionStretch } from '../../lib/market'

/** One stretch of the Market strip: a Qilowatt session (what it asked, what the grid delivered from its baseline, the
 *  baseline, the commands) or the time between sessions, and how the decisions in it compared with the automation. */
export function MarketSessionPopup({
  stretch,
  timeZone,
  nowS,
}: {
  stretch: SessionStretch
  timeZone?: string
  nowS: number
}) {
  const s = stretch.session
  const compared = sessionCompared(stretch)
  return (
    <div className="slot-pop">
      <div className="slot-pop-head">
        <span className="slot-pop-time">{formatSpan(stretch.from, stretch.to, timeZone)}</span>
        {s && (
          <span className="chip" data-color="amber">
            Session
          </span>
        )}
      </div>
      <div className="slot-pop-state">
        <span className="day-strip-swatch" style={{ background: s ? marketFill(s.direction) : NO_SETTINGS_FILL }} />
        <strong>{s ? sessionName(s) : 'No session'}</strong>
      </div>
      {s ? (
        <dl className="slot-pop-rows">
          {sessionRows(s, nowS).map((r) => (
            <div key={r.k}>
              <dt>{r.k}</dt>
              <dd>
                <span className="num">{r.v}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="slot-pop-note">The plan in force drives the inverter.</p>
      )}
      {compared && <p className="slot-pop-note">{compared}</p>}
    </div>
  )
}
