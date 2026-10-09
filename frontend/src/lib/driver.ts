import type { LampColor } from '../components/Lamp'

/** status.driver (app | legacy | both | none) as lamp, label and explanation. */
export function driverSpec(driver: string): { color: LampColor; text: string; explain: string } {
  switch (driver) {
    case 'app':
      return { color: 'green', text: 'EMHASS Lens', explain: 'EMHASS Lens sends the MPC runs and publishes the plan.' }
    case 'legacy':
      return {
        color: 'blue',
        text: 'HACS integration',
        explain: 'The HACS integration still runs MPC. EMHASS Lens builds its own payloads alongside and compares them.',
      }
    case 'both':
      return {
        color: 'red',
        text: 'Both — conflict',
        explain: 'EMHASS Lens live mode and the HACS integration Auto MPC are both on; EMHASS gets runs from both.',
      }
    default:
      return { color: 'neutral', text: 'Nobody', explain: 'Nothing sends scheduled MPC runs to EMHASS right now.' }
  }
}

/** Minutes after local midnight of a moment in `timeZone` (browser time if omitted). */
export function minuteOfDay(now: Date, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return hour * 60 + minute
}

/** Why now is a poor moment to switch who drives EMHASS, or null if it's a fine moment.
 * 13:45–15:00: tomorrow's day-ahead prices arrive and the horizon jumps; 23:45–00:15: day rollover. */
export function cutoverWarning(now: Date, timeZone?: string): string | null {
  const m = minuteOfDay(now, timeZone)
  if (m >= 13 * 60 + 45 && m < 15 * 60) {
    return "It's 13:45–15:00: tomorrow's prices are arriving and the plan's horizon is about to change. Switching a little later is safer."
  }
  if (m >= 23 * 60 + 45 || m < 15) {
    return "It's around midnight: the day rolls over in prices and tariffs. Switching a little later is safer."
  }
  return null
}
