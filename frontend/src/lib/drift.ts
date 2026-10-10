// The minute check that sets back what something else changed on the inverter or the EV charger.

import type { DriftStatus } from '../api/types'
import { formatTime } from './format'

export interface DriftText {
  color: 'green' | 'amber' | 'neutral'
  text: string
  detail: string | null
}

export function driftText(drift: DriftStatus | null | undefined, now: Date = new Date(), tz?: string): DriftText {
  if (!drift || !drift.enabled) return { color: 'neutral', text: 'Off', detail: 'Only in live mode, with the setting on.' }
  if (drift.fighting) {
    const field = String(drift.fighting.field ?? 'a setting')
    return {
      color: 'amber',
      text: `Stopped: something else keeps changing the ${field}`,
      detail: `Set back ${drift.fighting.count} times within an hour; EMHASS Lens tries again after an hour (since ${formatTime(String(drift.fighting.since), now, tz)}).`,
    }
  }
  const n = drift.corrections_1h ?? 0
  const corrections = n === 0 ? 'nothing to set back in the last hour' : n === 1 ? '1 correction in the last hour' : `${n} corrections in the last hour`
  const last = drift.checked_at ? `, last at ${formatTime(drift.checked_at, now, tz)}` : ''
  return { color: 'green', text: `Checked every minute${last}`, detail: corrections }
}
