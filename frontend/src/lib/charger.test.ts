import { describe, expect, it } from 'vitest'
import type { RunSummary } from '../api/types'
import { chargerFieldValue, chargerRules, decisionRef, pairCompares, parseChargerSummary } from './charger'

function run(id: number, job: string, startedAt: string, summary: string | null = null, outcome = 'ok'): RunSummary {
  return { id, job, trigger: 'manual', started_at: startedAt, scheduled_at: null, outcome, summary, pinned: 0 }
}

describe('parseChargerSummary', () => {
  it('reads the rule from dry-run and live summaries', () => {
    expect(parseChargerSummary("Would 'EMHASS: start charging' (emhass_start): press start, limit 8 A")).toEqual({
      rule: 'emhass_start',
      label: 'EMHASS: start charging',
    })
    expect(parseChargerSummary("Did 'Target SoC reached: stop charging' (soc_limit): press stop, limit 0 A")).toEqual({
      rule: 'soc_limit',
      label: 'Target SoC reached: stop charging',
    })
    expect(parseChargerSummary('Nothing to do: charge mode is Manual')).toEqual({ rule: 'none', label: 'Nothing to do' })
    expect(parseChargerSummary('Not connected to Home Assistant')).toBeNull()
  })
})

describe('pairCompares', () => {
  it('pairs each comparison with the decision it names, newest first, and keeps loose comparisons', () => {
    const decides = [run(10, 'charger.decide', '2026-10-09T11:15:05Z'), run(20, 'charger.decide', '2026-10-09T11:16:05Z')]
    const compares = [
      run(11, 'charger.compare', '2026-10-09T11:15:15Z', 'Decision #10: the automation did the same'),
      run(30, 'charger.compare', '2026-10-09T11:17:00Z', 'The automation set the current limit from 8 A to 0 A', 'mismatch'),
    ]
    const rows = pairCompares(decides, compares)
    expect(rows.map((r) => [r.decide?.id, r.compare?.id])).toEqual([
      [undefined, 30],
      [20, undefined],
      [10, 11],
    ])
    expect(decisionRef('Decision #10: differs — current_limit_a: decided 8, automation set 6.0')).toBe(10)
  })
})

describe('chargerRules and values', () => {
  it('lists the seven branches with the configured thresholds', () => {
    const list = chargerRules(undefined)
    expect(list.map((r) => r.id)).toEqual([
      'soc_limit',
      'emhass_start',
      'emhass_adjust',
      'emhass_pause',
      'solar_start',
      'solar_adjust',
      'solar_pause',
    ])
    expect(list.find((r) => r.id === 'soc_limit')?.when).toContain('5 min')
  })
  it('formats amps, percent and charger states', () => {
    expect(chargerFieldValue('current_limit_a', 8)).toBe('8 A')
    expect(chargerFieldValue('target_soc', 100)).toBe('100 %')
    expect(chargerFieldValue('state_raw', 4)).toBe('charging (4)')
    expect(chargerFieldValue('state_raw', null)).toBe('—')
  })
})
