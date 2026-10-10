import { describe, expect, it } from 'vitest'
import { dayBounds, localInputToIso, shiftDay, todayKey, zonedTime } from './days'

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
