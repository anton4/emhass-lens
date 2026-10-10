import type { Agreement } from '../../api/types'
import { formatAgreement } from '../../lib/inverter'
import { LabelledLamp } from '../Lamp'

/** How often the automation did the same as EMHASS Lens: a big percentage, a bar and "87 of 96 slots agreed"
 *  (decisions instead of slots for the charger and the market, which don't decide per slot). */
export function AgreementFact({
  title,
  agreement,
  per = 'slot',
}: {
  title: string
  agreement: Agreement | undefined
  per?: 'slot' | 'decision'
}) {
  const a = formatAgreement(agreement)
  const text = per === 'decision' ? a.text.replace('slots', 'decisions').replace('slot ', 'decision ') : a.text
  const rate = agreement && agreement.compared > 0 ? agreement.rate : null
  return (
    <div className="agreement-fact">
      <dt>{title}</dt>
      <dd>
        <span className="agreement-value">{a.percent}</span>
        {rate !== null && rate !== undefined && (
          <span className="agreement-bar" data-color={a.color} aria-hidden="true">
            <span style={{ width: `${Math.round(rate * 100)}%` }} />
          </span>
        )}
        <div className="cell-sub">
          {agreement && agreement.compared > 0 ? <LabelledLamp color={a.color} text={text} /> : a.text}
        </div>
      </dd>
    </div>
  )
}
