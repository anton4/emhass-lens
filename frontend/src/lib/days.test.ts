import { describe, expect, it } from 'vitest'
import {
  clampDay,
  dayBounds,
  dayChipLabel,
  dayLabel,
  isClosedRange,
  localInputToIso,
  shiftDay,
  stripDays,
  todayKey,
  zonedTime,
} from './days'

const tz = 'Europe/Tallinn'
const hours = (b: { since: string; until: string }) => (Date.parse(b.until) - Date.parse(b.since)) / 3_600_000

describe('dayBounds', () => {
  it('runs from local midnight to the next one', () => {
    expect(dayBounds('2026-10-10', tz)).toEqual({
      since: '2026-10-09T21:00:00.000Z',
      until: '2026-10-10T21:00:00.000Z',
    })
  })
  it('has 25 hours on the day summer time ends', () => {
    const b = dayBounds('2026-10-25', tz)
    expect(b).toEqual({ since: '2026-10-24T21:00:00.000Z', until: '2026-10-25T22:00:00.000Z' })
    expect(hours(b)).toBe(25)
  })
  it('has 23 hours on the day summer time starts', () => {
    const b = dayBounds('2026-03-29', tz)
    expect(b).toEqual({ since: '2026-03-28T22:00:00.000Z', until: '2026-03-29T21:00:00.000Z' })
    expect(hours(b)).toBe(23)
  })
  it('works in UTC', () => {
    expect(dayBounds('2026-10-10', 'UTC')).toEqual({
      since: '2026-10-10T00:00:00.000Z',
      until: '2026-10-11T00:00:00.000Z',
    })
  })
})

describe('days', () => {
  it('shifts across months and years', () => {
    expect(shiftDay('2026-10-31', 1)).toBe('2026-11-01')
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31')
  })
  it('knows today in the given time zone', () => {
    expect(todayKey(tz, new Date('2026-10-10T21:30:00Z'))).toBe('2026-10-11')
    expect(todayKey('UTC', new Date('2026-10-10T21:30:00Z'))).toBe('2026-10-10')
  })
  it('reads a wall-clock time in the time zone', () => {
    expect(zonedTime('2026-10-10', 14, 30, tz).toISOString()).toBe('2026-10-10T11:30:00.000Z')
    expect(zonedTime('2026-12-10', 14, 30, tz).toISOString()).toBe('2026-12-10T12:30:00.000Z')
    expect(localInputToIso('2026-10-10T14:30', tz)).toBe('2026-10-10T11:30:00.000Z')
    expect(localInputToIso('', tz)).toBe('')
    expect(localInputToIso('garbage', tz)).toBe('')
  })
})

describe('isClosedRange', () => {
  const now = Date.parse('2026-10-11T08:00:00Z')
  it('closes a range ten minutes after its end', () => {
    expect(isClosedRange('2026-10-10T21:00:00.000Z', now)).toBe(true)
    expect(isClosedRange('2026-10-11T07:55:00.000Z', now)).toBe(false)
    expect(isClosedRange('2026-10-11T07:49:00.000Z', now)).toBe(true)
  })
  it('keeps open ranges, the future and broken values open', () => {
    expect(isClosedRange(undefined, now)).toBe(false)
    expect(isClosedRange('2026-10-11T21:00:00.000Z', now)).toBe(false)
    expect(isClosedRange('garbage', now)).toBe(false)
  })
})

describe('stripDays and clampDay', () => {
  it('lists a week back and today, with tomorrow when asked', () => {
    const days = stripDays('2026-10-19')
    expect(days).toHaveLength(8)
    expect([days[0], days.at(-1)]).toEqual(['2026-10-12', '2026-10-19'])
    expect(stripDays('2026-10-31', 1, 1)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01'])
  })
  it('keeps a day within them, else today', () => {
    const days = stripDays('2026-10-19')
    expect(clampDay('2026-10-15', days, '2026-10-19')).toBe('2026-10-15')
    expect(clampDay('2026-10-01', days, '2026-10-19')).toBe('2026-10-19')
    expect(clampDay('nonsense', days, '2026-10-19')).toBe('2026-10-19')
    expect(clampDay(null, days, '2026-10-19')).toBe('2026-10-19')
  })
  it('names a day short and in full, whatever the browser time zone', () => {
    expect(dayChipLabel('2026-10-15')).toBe('Thu 15')
    expect(dayLabel('2026-10-25')).toBe('Sun 25 Oct')
  })
})
