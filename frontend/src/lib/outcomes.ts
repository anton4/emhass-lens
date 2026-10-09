import type { LampColor } from '../components/Lamp'

export const OUTCOMES: Record<string, { color: LampColor; text: string }> = {
  ok: { color: 'green', text: 'OK' },
  running: { color: 'green', text: 'Running' },
  dry_run: { color: 'blue', text: 'Dry run' },
  noop: { color: 'neutral', text: 'Nothing to do' },
  skipped: { color: 'neutral', text: 'Skipped' },
  cancelled: { color: 'neutral', text: 'Cancelled' },
  refused: { color: 'amber', text: 'Refused' },
  missed: { color: 'amber', text: 'Missed' },
  infeasible: { color: 'amber', text: 'Infeasible' },
  timeout: { color: 'red', text: 'Timed out' },
  error: { color: 'red', text: 'Error' },
}

export const OUTCOME_NAMES = Object.keys(OUTCOMES)

export function outcomeLabel(outcome: string): string {
  return OUTCOMES[outcome]?.text ?? outcome
}

