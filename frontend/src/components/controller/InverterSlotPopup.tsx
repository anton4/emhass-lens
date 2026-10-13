import { formatClock } from '../../lib/format'
import { pressButton, pressColor, pressWho } from '../../lib/presses'
import {
  FIELD_LABELS,
  fieldValue,
  modeTone,
  NOT_IN_CONTROL_FILL,
  type DecisionAction,
  type SlotDetail,
} from '../../lib/inverter'
import type { LampColor } from '../Lamp'

const SLOT_MS = 15 * 60 * 1000
const FIELDS = ['state', 'grid_power_w', 'battery_min_w', 'battery_max_w', 'feedin_max_w'] as const

const ACTION_CHIP: Record<DecisionAction['kind'], { text: string; color: LampColor }> = {
  would: { text: 'Would set', color: 'blue' },
  set: { text: 'Set', color: 'green' },
  already: { text: 'Already set', color: 'neutral' },
  blocked: { text: 'Not in control', color: 'amber' },
}

/** One slot of the inverter's day strip: the five Sofar settings it set (or would set), which changed since the slot
 *  before, where the automation set something else, and who pressed the Sofar buttons in it. */
export function InverterSlotPopup({ detail, timeZone }: { detail: SlotDetail; timeZone?: string }) {
  const clock = (ms: number) => formatClock(new Date(ms).toISOString(), timeZone).slice(0, 5)
  const t = detail.targets
  const chip = detail.action ? ACTION_CHIP[detail.action.kind] : null
  const blocked = detail.action?.kind === 'blocked'
  const note = slotNote(detail)
  return (
    <div className="slot-pop">
      <div className="slot-pop-head">
        <span className="slot-pop-time">
          {clock(detail.slot)}–{clock(detail.slot + SLOT_MS)}
        </span>
        {chip && (
          <span className="chip" data-color={chip.color === 'neutral' ? undefined : chip.color}>
            {chip.text}
          </span>
        )}
      </div>
      {t ? (
        <>
          <div className="slot-pop-state">
            <span
              className="day-strip-swatch"
              style={{ background: blocked ? NOT_IN_CONTROL_FILL : modeTone(t.state).fill }}
            />
            <strong>{t.state}</strong>
            <span className="rule-badge small word">{t.rule}</span>
          </div>
          <dl className="slot-pop-rows">
            {FIELDS.map((f) => {
              const value = t[f]
              const automation = detail.differs[f]
              return (
                <div key={f} data-differs={automation !== undefined || undefined}>
                  <dt>{FIELD_LABELS[f]}</dt>
                  <dd>
                    <span className={f === 'state' ? undefined : 'num'}>
                      {value === null ? 'unchanged' : fieldValue(f, value)}
                    </span>
                    {detail.changed.includes(f) && <span className="slot-pop-changed">changed</span>}
                    {value === null && (
                      <span className="slot-pop-sub">
                        {detail.feedinBefore
                          ? `${fieldValue(f, detail.feedinBefore.value)} since ${clock(detail.feedinBefore.slot)}`
                          : 'not set earlier today'}
                      </span>
                    )}
                    {automation !== undefined && <span className="slot-pop-auto">Automation set {automation}</span>}
                  </dd>
                </div>
              )
            })}
          </dl>
        </>
      ) : (
        <p className="slot-pop-note">{detail.summary ?? 'No decision recorded for this slot.'}</p>
      )}
      {note && <p className="slot-pop-note">{note}</p>}
      {detail.presses && detail.presses.length > 0 && (
        <ul className="slot-pop-presses" aria-label="Button presses in this slot">
          {detail.presses.map((p, i) => (
            <li key={`${p.at}-${i}`}>
              <span className="day-strip-swatch dot" style={{ background: pressColor(p) }} />
              <span className="num">{formatClock(p.at, timeZone)}</span>
              <span>
                {pressButton(p)} pressed by {pressWho(p)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function slotNote(d: SlotDetail): string | null {
  if (!d.targets) return null
  const differs = Object.keys(d.differs).map((f) => (FIELD_LABELS[f] ?? f).toLowerCase())
  const automation =
    differs.length > 0
      ? `The automation differed on ${differs.join(', ')}.`
      : d.compare === 'ok'
        ? 'The automation set the same.'
        : null
  const drift = d.action?.drift ? `Drift: ${d.action.drift}; set back.` : null
  switch (d.action?.kind) {
    case 'blocked': {
      const why = d.action.reason ? `Not in control: ${d.action.reason}. ` : ''
      return `${why}Nothing was written; these are the settings it would have set.`
    }
    case 'already':
      return 'Nothing written: the inverter already had these settings.'
    case 'set':
      return drift ?? 'Written to the inverter.'
    default:
      return automation
  }
}
