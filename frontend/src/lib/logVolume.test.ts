import { describe, expect, it } from 'vitest'
import { logVolume } from './logVolume'

const at = (iso: string, level = 'INFO') => ({ ts: iso, level })

describe('logVolume', () => {
  it('counts lines, warnings and errors per bucket up to the end', () => {
    const end = Date.parse('2026-10-10T19:15:00Z') / 1000
    const buckets = logVolume(
      [
        at('2026-10-10T19:14:10Z'),
        at('2026-10-10T19:13:00Z', 'WARNING'),
        at('2026-10-10T19:12:00Z', 'ERROR'),
        at('2026-10-10T19:01:00Z', 'CRITICAL'),
        at('2026-10-10T15:00:00Z'), // before the window
      ],
      end,
      4,
      300,
    )
    expect(buckets.map((b) => b.total)).toEqual([0, 1, 0, 3])
    expect(buckets[3]).toMatchObject({ warnings: 1, errors: 1 })
    expect(buckets[1]).toMatchObject({ errors: 1, warnings: 0 })
    expect(buckets[0]?.start).toBe(end - 4 * 300)
  })
})
