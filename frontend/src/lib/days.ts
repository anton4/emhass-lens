// Calendar days in the Home Assistant time zone: a day's [since, until) as UTC instants for the API,
// correct across DST changes (a day can have 23 or 25 hours).

import { dayKey } from './format'

/** Milliseconds `timeZone` is ahead of UTC at `date`. */
function offsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - Math.floor(date.getTime() / 1000) * 1000
}

/** The instant a wall-clock time ("2026-10-10", 14:30) happens in `timeZone` (browser time when omitted). */
export function zonedTime(day: string, hours = 0, minutes = 0, timeZone?: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  if (!timeZone) return new Date(y!, m! - 1, d!, hours, minutes)
  const wall = Date.UTC(y!, m! - 1, d!, hours, minutes)
  let ts = wall - offsetMs(new Date(wall), timeZone)
  ts = wall - offsetMs(new Date(ts), timeZone) // a second pass lands on the right side of a DST change
  return new Date(ts)
}

export function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10)
}

export function todayKey(timeZone?: string, now: Date = new Date()): string {
  return dayKey(now, timeZone)
}

/** [since, until) of a calendar day in `timeZone`, as ISO instants for the API. */
export function dayBounds(day: string, timeZone?: string): { since: string; until: string } {
  return {
    since: zonedTime(day, 0, 0, timeZone).toISOString(),
    until: zonedTime(shiftDay(day, 1), 0, 0, timeZone).toISOString(),
  }
}

/** A `datetime-local` value ("2026-10-10T14:30") read in `timeZone`, as an ISO instant; '' stays ''. */
export function localInputToIso(value: string, timeZone?: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(value)
  if (!match) return ''
  return zonedTime(match[1]!, Number(match[2]), Number(match[3]), timeZone).toISOString()
}

/** Whether a range ended more than `marginMs` ago, so its runs no longer change (one that started just before the
 * end has finished by then). Lists of such a range need no reloading. */
export function isClosedRange(until: string | undefined, now: number = Date.now(), marginMs = 10 * 60_000): boolean {
  if (!until) return false
  const end = Date.parse(until)
  return Number.isFinite(end) && end < now - marginMs
}
