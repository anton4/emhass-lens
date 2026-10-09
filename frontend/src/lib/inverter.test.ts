import { describe, expect, it } from 'vitest'
import type { RunSummary } from '../api/types'
import { decideChip, fieldValue, formatAgreement, mergeBySlot, parseDecisionSummary, rules, runSlot } from './inverter'

function run(id: number, job: string, startedAt: string, outcome = 'ok', summary: string | null = null): RunSummary {
  return { id, job, trigger: 'schedule', started_at: startedAt, scheduled_at: null, outcome, summary, pinned: 0 }
}

describe('formatAgreement', () => {
  it('says when nothing has been compared', () => {
    expect(formatAgreement(null).text).toBe('No comparisons yet')
    expect(formatAgreement({ hours: 24, compared: 0, agreed: 0, rate: null }).percent).toBe('—')
  })
  it('rounds the rate and colours it', () => {
    expect(formatAgreement({ hours: 24, compared: 8, agreed: 7, rate: 0.875 })).toEqual({
      text: '7 of 8 slots agreed',
      percent: '88 %',
      color: 'red',
    })
    expect(formatAgreement({ hours: 24, compared: 96, agreed: 96, rate: 1 }).color).toBe('green')
    expect(formatAgreement({ hours: 24, compared: 1, agreed: 1, rate: 1 }).text).toBe('1 of 1 slot agreed')
  })
})

describe('parseDecisionSummary', () => {
  it('reads the rule from dry-run and live summaries', () => {
    expect(parseDecisionSummary("Would set 'Force charge' (rule g): grid 5600 W, battery -3000…20000 W, feed-in 0 W")).toEqual(
      { rule: 'g', label: 'Force charge' },
    )
    expect(parseDecisionSummary("Set 'Self-use battery or PV' (rule b): grid 0 W")).toEqual({
      rule: 'b',
      label: 'Self-use battery or PV',
    })
    expect(parseDecisionSummary('Would set no passive-mode change (no rule matches); feed-in 15500 W')).toEqual({
      rule: 'none',
      label: 'No change',
    })
    expect(parseDecisionSummary('Nothing to decide: no plan row for this slot')).toBeNull()
  })
})

describe('mergeBySlot', () => {
  it('pairs decide and compare runs of the same slot, newest slot first', () => {
    const decides = [
      run(10, 'inverter.decide', '2026-10-09T11:15:05Z', 'dry_run'),
      run(20, 'inverter.decide', '2026-10-09T11:30:05Z', 'dry_run'),
    ]
    const compares = [run(11, 'inverter.compare', '2026-10-09T11:15:45Z', 'mismatch')]
    const rows = mergeBySlot(decides, compares)
    expect(rows.map((r) => [new Date(r.slot).toISOString(), r.decide?.id, r.compare?.id])).toEqual([
      ['2026-10-09T11:30:00.000Z', 20, undefined],
      ['2026-10-09T11:15:00.000Z', 10, 11],
    ])
  })
  it('keeps the newest run when a slot was decided twice', () => {
    const rows = mergeBySlot(
      [run(5, 'inverter.decide', '2026-10-09T11:15:05Z'), run(7, 'inverter.decide', '2026-10-09T11:20:00Z')],
      [],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decide?.id).toBe(7)
  })
  it('uses the scheduled time when there is one', () => {
    const r = { ...run(1, 'inverter.decide', '2026-10-09T11:30:01Z'), scheduled_at: '2026-10-09T11:29:59Z' }
    expect(new Date(runSlot(r)).toISOString()).toBe('2026-10-09T11:15:00.000Z')
  })
})

describe('rules', () => {
  it('lists nine rules in the automation order with the configured thresholds', () => {
    const list = rules(undefined)
    expect(list.map((r) => r.id).join('')).toBe('abcdefghi')
    expect(list.find((r) => r.id === 'e')?.note).toContain('unreachable')
    expect(list.find((r) => r.id === 'g')?.sets).toContain('18800 W if P_grid > 9000 W')
  })
})

describe('fieldValue', () => {
  it('shows watts and states', () => {
    expect(fieldValue('grid_power_w', 5600.4)).toBe('5600 W')
    expect(fieldValue('state', 'Force charge')).toBe('Force charge')
    expect(fieldValue('feedin_max_w', null)).toBe('—')
  })
})

describe('decideChip', () => {
  it('names decisions made while the automation was not in control', () => {
    expect(decideChip({ outcome: 'noop', summary: "Not in control (x is 'off'); would: 'Force charge' (rule g)" })).toEqual({
      color: 'amber',
      text: 'Not in control',
    })
    expect(decideChip({ outcome: 'noop', summary: 'Nothing to decide: no plan row for this slot' })).toBeNull()
    expect(decideChip({ outcome: 'dry_run', summary: "Would set 'Force charge' (rule g)" })).toBeNull()
  })
})
