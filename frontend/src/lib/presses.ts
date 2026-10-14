// Presses of the Sofar "apply passive settings" and "apply feed-in limit" buttons, by EMHASS Lens or anyone else:
// every press writes the inverter's EEPROM.

import type { ButtonPress } from '../api/types'
import type { StripTick } from './dayStrip'

const SLOT_MS = 15 * 60 * 1000

const WHO: Record<string, string> = {
  lens: 'EMHASS Lens',
  automation: 'an automation',
  user: 'a user',
  unknown: 'not known',
}

/** Who pressed: "EMHASS Lens" (with "for the plan" or "for a market session" when the run is known), "an automation",
 *  "a user" (in the UI, or through a script they ran) or "not known". */
export function pressWho(p: Pick<ButtonPress, 'source' | 'owner'>, capital = false): string {
  const who = WHO[p.source] ?? WHO.unknown!
  // ours: whether the run wrote for the plan or for a market session
  const text =
    p.source === 'lens' && p.owner ? `${who} ${p.owner === 'market' ? 'for a market session' : 'for the plan'}` : who
  return capital ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

/** Which button, as what it commits. */
export function pressButton(p: Pick<ButtonPress, 'button' | 'entity_id'>): string {
  return p.button === 'apply' ? 'Passive settings' : p.button === 'feedin' ? 'Feed-in limit' : p.entity_id
}

export function pressedOutside(p: Pick<ButtonPress, 'source'>): boolean {
  return p.source !== 'lens'
}

/** The presses within the quarter-hour that starts at `slotMs`, oldest first. */
export function pressesInSlot(presses: ButtonPress[], slotMs: number): ButtonPress[] {
  return presses
    .filter((p) => {
      const t = Date.parse(p.at)
      return t >= slotMs && t < slotMs + SLOT_MS
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

/** The colours of the press marks: a press from outside EMHASS Lens stands out. */
export const PRESS_COLOR = { outside: 'var(--lamp-red)', lens: 'var(--ink-2)' }

export function pressColor(p: Pick<ButtonPress, 'source'>): string {
  return pressedOutside(p) ? PRESS_COLOR.outside : PRESS_COLOR.lens
}

/** One mark on the day strip per press. */
export function pressTicks(presses: ButtonPress[]): StripTick[] {
  return presses.map((p) => ({ t: Date.parse(p.at) / 1000, color: pressColor(p) }))
}

/** How many presses in [since, until) came from outside EMHASS Lens and how many from it. */
export function pressCounts(presses: ButtonPress[], since: string, until: string): { outside: number; lens: number } {
  const from = Date.parse(since)
  const to = Date.parse(until)
  const counts = { outside: 0, lens: 0 }
  for (const p of presses) {
    const t = Date.parse(p.at)
    if (t >= from && t < to) counts[pressedOutside(p) ? 'outside' : 'lens']++
  }
  return counts
}
