import { AGREE_TONES, agreeText, formatSpan, type AgreeRun } from '../../lib/dayStrip'

/** One stretch of the Automation row: when, whether the automation agreed, how many slots or decisions, and where it
 *  differed (`differs`: each differing mark's time and what was different). */
export function AgreePopup({
  run,
  from,
  until,
  what,
  timeZone,
  differs,
}: {
  run: AgreeRun
  /** Unix seconds. */
  from: number
  until: number
  what: string
  timeZone?: string
  differs: { at: string; text: string | null }[]
}) {
  const tone = AGREE_TONES[run.state]
  return (
    <div className="slot-pop">
      <div className="slot-pop-head">
        <span className="slot-pop-time">{formatSpan(from, until, timeZone)}</span>
      </div>
      <div className="slot-pop-state">
        <span className="day-strip-swatch" style={{ background: tone.fill }} />
        <strong>{tone.title}</strong>
      </div>
      <p className="slot-pop-note">{agreeText(run, what)}</p>
      {differs.length > 0 && (
        <ul className="agree-pop-differs">
          {differs.map((d) => (
            <li key={d.at}>
              <span className="num">{d.at}</span> {d.text ?? 'the automation did something else'}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
