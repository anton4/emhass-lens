import { describe, expect, it } from 'vitest'
import { clearOf, cursorTimeLabel, dayDateLabel, dayTimeLabel, localMidnights, rangeLabel, spanLabel } from './chartTime'

const TZ = 'Europe/Tallinn'
const at = (iso: string) => Date.parse(iso) / 1000

describe('localMidnights', () => {
  it('finds each local midnight after the start', () => {
    expect(localMidnights(at('2026-10-15T12:00:00Z'), at('2026-10-17T12:00:00Z'), TZ)).toEqual([
      at('2026-10-15T21:00:00Z'),
      at('2026-10-16T21:00:00Z'),
    ])
  })

  it('leaves out a midnight at the start and keeps one at the end', () => {
    const m = at('2026-10-15T21:00:00Z')
    expect(localMidnights(m, m + 86400, TZ)).toEqual([m + 86400])
  })

  it('follows the clock across the end of summer time (a 25-hour day)', () => {
    expect(localMidnights(at('2026-10-24T12:00:00Z'), at('2026-10-26T12:00:00Z'), TZ)).toEqual([
      at('2026-10-24T21:00:00Z'),
      at('2026-10-25T22:00:00Z'),
    ])
  })
})

describe('spanLabel', () => {
  it('says seconds, minutes, hours or days', () => {
    expect(spanLabel(40)).toBe('40 s')
    expect(spanLabel(45 * 60)).toBe('45 min')
    expect(spanLabel(3 * 3600)).toBe('3 h')
    expect(spanLabel(3 * 3600 + 45 * 60)).toBe('3 h 45 min')
    expect(spanLabel(2.6 * 86400)).toBe('2.6 days')
    expect(spanLabel(36 * 3600)).toBe('36 h')
  })
})

describe('rangeLabel', () => {
  it('gives only the times within a day', () => {
    expect(rangeLabel(at('2026-10-16T09:45:00Z'), at('2026-10-16T13:30:00Z'), TZ)).toBe('12:45 – 16:30')
  })

  it('gives the weekdays across days', () => {
    expect(rangeLabel(at('2026-10-15T12:30:00Z'), at('2026-10-18T02:00:00Z'), TZ)).toBe('Thu 15:30 → Sun 05:00')
  })
})

describe('cursorTimeLabel', () => {
  it('has seconds for a reading and minutes otherwise', () => {
    const t = at('2026-10-16T10:25:20Z')
    expect(cursorTimeLabel(t, TZ, true)).toBe('13:25:20')
    expect(cursorTimeLabel(t, TZ, false)).toBe('13:25')
  })
})

describe('clearOf', () => {
  it('is false within the gap of any position, and ignores unknown ones', () => {
    expect(clearOf(100, [140, null], 52)).toBe(false)
    expect(clearOf(100, [160, undefined], 52)).toBe(true)
  })
})

describe('dayTimeLabel', () => {
  it('gives the weekday and the time', () => {
    expect(dayTimeLabel(Date.parse('2026-10-17T00:00:00Z') / 1000, TZ)).toBe('Sat 03:00')
  })
})

describe('dayDateLabel', () => {
  it('gives the weekday, the day and the month', () => {
    expect(dayDateLabel(Date.parse('2026-10-16T09:00:00Z') / 1000, TZ)).toBe('Fri 16 Oct')
  })
})
