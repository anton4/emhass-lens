// Helpers for the Home Assistant entity picker (pure, so they can be tested without a DOM).

import { formatDateTime, parseTime } from './format'

/** The domains a field accepts, from its ui.domain hint ("sensor" or ["sensor", "input_number"]). */
export function entityDomains(domain: string | string[] | undefined): string[] {
  if (!domain) return []
  return (Array.isArray(domain) ? domain : [domain]).filter(Boolean)
}

// Domains whose state is a moment in UTC ISO (a button's is the time of its last press)
const TIMESTAMP_DOMAINS = ['button', 'input_button', 'scene', 'event', 'datetime']
const PRESSED_DOMAINS = ['button', 'input_button']
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

/** The state as Home Assistant shows it: "62 %", "on", "unavailable", "pressed Mon, Oct 12, 13:15:02" (a moment
 * in `timeZone`, the App's, rather than the UTC ISO string Home Assistant stores). */
export function entityReading(
  entity: { entity_id?: string; state?: string | null; unit?: string | null; device_class?: string | null },
  timeZone?: string,
): string {
  const state = entity.state ?? ''
  if (!state) return ''
  const domain = entity.entity_id?.split('.')[0] ?? ''
  const moment = TIMESTAMP_DOMAINS.includes(domain) || entity.device_class === 'timestamp'
  if (moment && ISO_TIME.test(state) && parseTime(state)) {
    return `${PRESSED_DOMAINS.includes(domain) ? 'pressed ' : ''}${formatDateTime(state, timeZone)}`
  }
  return entity.unit && !['unavailable', 'unknown'].includes(state) ? `${state} ${entity.unit}` : state
}

export interface Segment {
  text: string
  match: boolean
}

/** Splits text into runs that do or don't match any of the search words (case-insensitive). */
export function matchSegments(text: string, search: string): Segment[] {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean)
  if (!text) return []
  if (terms.length === 0) return [{ text, match: false }]
  const lower = text.toLowerCase()
  const marked = new Array<boolean>(text.length).fill(false)
  for (const term of terms) {
    for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + term.length)) {
      marked.fill(true, at, at + term.length)
    }
  }
  const segments: Segment[] = []
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i)
    const match = marked[i] === true
    const last = segments[segments.length - 1]
    if (last && last.match === match) last.text += char
    else segments.push({ text: char, match })
  }
  return segments
}
