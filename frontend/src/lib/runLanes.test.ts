import { describe, expect, it } from 'vitest'
import { axisTicks, laneOf } from './runLanes'

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
