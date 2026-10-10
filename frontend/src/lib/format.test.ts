import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  formatCountdown,
  formatDateTime,
  formatDuration,
  formatQuarterOffset,
  formatSlotDate,
  formatValue,
} from './format'

describe('formatDuration', () => {
  it('scales units', () => {
    expect(formatDuration(820)).toBe('820 ms')
    expect(formatDuration(4200)).toBe('4.2 s')
    expect(formatDuration(42_000)).toBe('42 s')
    expect(formatDuration(125_000)).toBe('2 min 05 s')
    expect(formatDuration(3_780_000)).toBe('1 h 03 min')
    expect(formatDuration(null)).toBe('—')
  })
})

describe('formatCountdown', () => {
  const now = new Date('2026-10-09T11:00:00Z')
  it('counts down and up', () => {
    expect(formatCountdown('2026-10-09T11:04:32Z', now)).toBe('in 4:32')
    expect(formatCountdown('2026-10-09T12:05:00Z', now)).toBe('in 1 h 05 min')
    expect(formatCountdown('2026-10-09T10:57:00Z', now)).toBe('3:00 ago')
    expect(formatCountdown('2026-10-11T13:00:00Z', now)).toBe('in 2 d 2 h')
    expect(formatCountdown('2026-10-09T11:00:00Z', now)).toBe('now')
    expect(formatCountdown(null, now)).toBe('—')
  })
})

describe('formatQuarterOffset', () => {
  it('lists the four clock positions', () => {
    expect(formatQuarterOffset(780)).toBe(':13:00, :28:00, :43:00, :58:00')
    expect(formatQuarterOffset(2)).toBe(':00:02, :15:02, :30:02, :45:02')
    expect(formatQuarterOffset(30)).toBe(':00:30, :15:30, :30:30, :45:30')
  })
})

describe('formatBytes / formatValue', () => {
  it('formats', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(14_540)).toBe('14.2 KiB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MiB')
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.50 GiB')
    expect(formatBytes(null)).toBe('—')
    expect(formatValue(null)).toBe('empty')
    expect(formatValue('')).toBe('""')
    expect(formatValue({ a: 1 })).toBe('{"a":1}')
  })
})

describe('formatSlot', () => {
  it('shows 24-hour times, with the weekday on other days', async () => {
    const { formatSlot } = await import('./format')
    const now = new Date(2026, 9, 9, 12, 0)
    expect(formatSlot(new Date(2026, 9, 9, 17, 45).toISOString(), now)).toMatch(/17[:.]45/)
    expect(formatSlot(new Date(2026, 9, 10, 7, 0).toISOString(), now)).toMatch(/07[:.]00/)
    expect(formatSlot(new Date(2026, 9, 10, 7, 0).toISOString(), now)).not.toBe(formatSlot(new Date(2026, 9, 9, 7, 0).toISOString(), now))
    expect(formatSlot(null)).toBe('—')
  })
})

describe('dated times', () => {
  const now = new Date('2026-10-10T12:00:00Z')
  const tz = 'Europe/Tallinn'
  it('always shows the day, and the year only when it differs', () => {
    expect(formatDateTime('2026-10-10T15:15:02Z', tz, now)).toBe('Sat, Oct 10, 18:15:02')
    expect(formatDateTime('2025-12-31T22:30:00Z', tz, now)).toBe('Thu, Jan 1, 00:30:00')
    expect(formatSlotDate('2026-10-10T15:15:00Z', tz, now)).toBe('Sat, Oct 10, 18:15')
    expect(formatSlotDate('2025-10-10T15:15:00Z', tz, now)).toBe('Fri, Oct 10, 2025, 18:15')
  })
  it('shows a dash for a missing or broken time', () => {
    expect(formatDateTime('nope', tz, now)).toBe('—')
    expect(formatSlotDate(null, tz, now)).toBe('—')
  })
})
