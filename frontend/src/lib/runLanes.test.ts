import { describe, expect, it } from 'vitest'
import { axisTicks, laneOf, timelineBounds, timelineCells, type CellColor } from './runLanes'

describe('laneOf', () => {
  it('groups jobs by their prefix', () => {
    expect(laneOf('emhass.mpc')).toBe('EMHASS')
    expect(laneOf('forecast.ee.poll')).toBe('Prices')
    expect(laneOf('external.resume')).toBe('Market')
    expect(laneOf('maintenance.retention')).toBe('System')
  })
})

describe('axisTicks', () => {
  it('uses whole hours across a day', () => {
    const from = Date.parse('2026-10-10T00:10:00Z') / 1000
    const ticks = axisTicks(from, from + 86400)
    expect(ticks.length).toBeGreaterThanOrEqual(4)
    expect(ticks.every((t) => t % 3600 === 0)).toBe(true)
  })

  it('uses round minutes across a few minutes', () => {
    const from = Date.parse('2026-10-10T19:27:30Z') / 1000
    const ticks = axisTicks(from, from + 8 * 60)
    expect(ticks.length).toBeGreaterThanOrEqual(4)
    expect(ticks.every((t) => t % 60 === 0)).toBe(true)
  })

  it('is empty for an empty window', () => {
    expect(axisTicks(100, 100)).toEqual([])
  })
})

describe('timelineBounds', () => {
  it('ends the window at the next bucket boundary', () => {
    const now = Date.parse('2026-10-10T14:07:30Z') / 1000
    const b = timelineBounds('6h', now)
    expect(b.to).toBe(Date.parse('2026-10-10T14:10:00Z') / 1000)
    expect(b.to - b.from).toBe(6 * 3600)
    expect(b.count).toBe(72)
    expect(timelineBounds('24h', now).count).toBe(96)
    expect(timelineBounds('1h', now).count).toBe(60)
  })
})

describe('timelineCells', () => {
  const color = (o: string) =>
    (({ ok: 'green', error: 'red', dry_run: 'blue', noop: 'neutral', refused: 'amber' }) as Record<string, CellColor>)[
      o
    ] ?? 'neutral'

  it('colours a bucket by its most notable outcome and opens the newest run of it', () => {
    const { lanes, totals } = timelineCells(
      [
        { job: 'emhass.mpc', bucket: 3, outcome: 'ok', count: 2, last_id: 12 },
        { job: 'emhass.mpc', bucket: 3, outcome: 'error', count: 1, last_id: 10 },
        { job: 'emhass.health', bucket: 3, outcome: 'error', count: 1, last_id: 11 },
        { job: 'nordpool.poll', bucket: 5, outcome: 'noop', count: 1, last_id: 13 },
        { job: 'measure.sample', bucket: 99, outcome: 'ok', count: 1, last_id: 14 }, // outside the window
      ],
      10,
      color,
    )
    expect(lanes.map((l) => l.lane)).toEqual(['EMHASS', 'Prices'])
    const cell = lanes[0]?.cells[3]
    expect(cell?.color).toBe('red')
    expect(cell?.runId).toBe(11)
    expect(cell?.counts).toEqual([
      { outcome: 'error', count: 2 },
      { outcome: 'ok', count: 2 },
    ])
    expect(lanes[0]?.cells[2]).toBeNull()
    expect(totals).toMatchObject({ green: 2, red: 2, neutral: 1 })
  })
})
