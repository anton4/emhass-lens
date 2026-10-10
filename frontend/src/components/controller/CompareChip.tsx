import { Lamp } from '../Lamp'
import { OutcomeChip } from '../Outcome'

/** The automation-comparison outcome of a decision, in words: Same, Differs, or the run's outcome otherwise. */
export function CompareChip({ outcome }: { outcome: string }) {
  if (outcome === 'ok' || outcome === 'mismatch') {
    const same = outcome === 'ok'
    return (
      <span className="chip" data-color={same ? 'green' : 'amber'}>
        <Lamp color={same ? 'green' : 'amber'} />
        {same ? 'Same' : 'Differs'}
      </span>
    )
  }
  return <OutcomeChip outcome={outcome} />
}
