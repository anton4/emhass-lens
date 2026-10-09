import { OUTCOMES } from '../lib/outcomes'
import { Lamp, type LampColor } from './Lamp'

export function OutcomeChip({ outcome }: { outcome: string | null | undefined }) {
  if (!outcome) return <span className="faint">—</span>
  const spec = OUTCOMES[outcome] ?? { color: 'neutral' as LampColor, text: outcome }
  return (
    <span className="chip" data-color={spec.color === 'neutral' ? undefined : spec.color}>
      <Lamp color={spec.color} pulse={outcome === 'running'} />
      {spec.text}
    </span>
  )
}
