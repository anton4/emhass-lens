import { describe, expect, it } from 'vitest'
import type { RunSummary } from '../api/types'
import { decisionRef, marketFieldValue, marketGuards, pairMarketCompares, parseReconcileSummary } from './market'

function run(id: number, job: string, startedAt: string, summary: string | null = null, outcome = 'ok'): RunSummary {
  return { id, job, trigger: 'event', started_at: startedAt, scheduled_at: null, outcome, summary, pinned: 0 }
}

describe('parseReconcileSummary', () => {
  it('reads commands, ends, ignores and blocks', () => {
    expect(parseReconcileSummary('Would: Kratt sell 5000W')).toEqual({ kind: 'command', text: 'Kratt sell 5000W' })
    expect(parseReconcileSummary("Kratt sell 7000W: set 'Force discharge', grid -7000 W")).toEqual({ kind: 'command', text: 'Kratt sell 7000W' })
    expect(parseReconcileSummary('Qilowatt safeguard: session ended (mode_cleared). source=kratt mode=none soc=55% powerlimit=0W. Control returned to EMHASS. Handed the inverter back to the plan.')).toEqual({
      kind: 'end',
      text: 'session ended (mode cleared)',
    })
    expect(parseReconcileSummary('Would: Qilowatt safeguard: ignored kratt mfrrup with powerlimit 0W.')?.kind).toBe('ignored')
    expect(parseReconcileSummary("Not in control (input_boolean.qilowatt_automation is 'off'); would: Kratt sell 5000W")?.kind).toBe('blocked')
    expect(parseReconcileSummary('No action: kratt none 0 W, session none → none')).toEqual({ kind: 'none', text: 'kratt none 0 W, session none → none' })
    expect(parseReconcileSummary(null)).toBeNull()
  })
})

describe('pairMarketCompares', () => {
  it('pairs comparisons with the decision they name', () => {
    const reconciles = [run(10, 'market.reconcile', '2026-10-09T11:15:05Z'), run(20, 'market.reconcile', '2026-10-09T11:16:05Z')]
    const compares = [run(11, 'market.compare', '2026-10-09T11:15:17Z', 'Decision #10: the automation did the same')]
    expect(pairMarketCompares(reconciles, compares).map((r) => [r.reconcile?.id, r.compare?.id])).toEqual([
      [20, undefined],
      [10, 11],
    ])
    expect(decisionRef('Decision #10: differs — session: expected sell, HA shows none')).toBe(10)
  })
})

describe('marketGuards and values', () => {
  it('names the guards with the configured thresholds', () => {
    const guards = marketGuards(undefined)
    expect(guards).toHaveLength(4)
    expect(guards[0]?.text).toContain('1000 W')
    expect(guards[2]?.text).toContain('180 s')
    expect(marketFieldValue('grid_power_w', -5000)).toBe('-5000 W')
    expect(marketFieldValue('session', 'sell')).toBe('sell')
  })
})
