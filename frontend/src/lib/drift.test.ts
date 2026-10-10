import { describe, expect, it } from 'vitest'
import { driftText } from './drift'

const now = new Date('2026-10-10T14:00:00Z')

describe('driftText', () => {
  it('says whether the minute check runs and what it did', () => {
    expect(driftText(null).text).toBe('Off')
    expect(driftText({ enabled: false, corrections_1h: 0 }).color).toBe('neutral')
    const ok = driftText({ enabled: true, checked_at: '2026-10-10T13:59:30Z', corrections_1h: 0 }, now, 'Europe/Tallinn')
    expect(ok).toEqual({ color: 'green', text: 'Checked every minute, last at 16:59:30', detail: 'nothing to set back in the last hour' })
    expect(driftText({ enabled: true, corrections_1h: 2 }, now).detail).toBe('2 corrections in the last hour')
  })

  it('says when something else keeps changing it', () => {
    const fight = { field: 'grid power', since: '2026-10-10T13:40:00Z', count: 3 }
    const got = driftText({ enabled: true, corrections_1h: 3, fighting: fight }, now, 'Europe/Tallinn')
    expect(got.color).toBe('amber')
    expect(got.text).toBe('Stopped: something else keeps changing the grid power')
    expect(got.detail).toContain('Set back 3 times within an hour')
  })
})
