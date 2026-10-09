import { describe, expect, it } from 'vitest'
import { cutoverWarning, driverSpec, minuteOfDay } from './driver'

describe('cutover timing', () => {
  const tz = 'Europe/Tallinn'
  it('reads the local minute of the day in the given timezone', () => {
    expect(minuteOfDay(new Date('2026-10-09T11:13:00Z'), tz)).toBe(14 * 60 + 13)
    expect(minuteOfDay(new Date('2026-01-09T22:05:00Z'), tz)).toBe(5)
  })
  it('warns while tomorrow prices arrive and around midnight only', () => {
    expect(cutoverWarning(new Date('2026-10-09T10:50:00Z'), tz)).toMatch(/13:45–15:00/) // 13:50 local
    expect(cutoverWarning(new Date('2026-10-09T12:05:00Z'), tz)).toBeNull() // 15:05 local
    expect(cutoverWarning(new Date('2026-10-09T20:50:00Z'), tz)).toMatch(/midnight/) // 23:50 local
    expect(cutoverWarning(new Date('2026-10-09T21:10:00Z'), tz)).toMatch(/midnight/) // 00:10 local
    expect(cutoverWarning(new Date('2026-10-09T07:00:00Z'), tz)).toBeNull()
  })
})

describe('driverSpec', () => {
  it('flags two drivers as a conflict', () => {
    expect(driverSpec('both').color).toBe('red')
    expect(driverSpec('app').text).toBe('EMHASS Lens')
  })
})
