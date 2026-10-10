import { describe, expect, it } from 'vitest'
import type { PlanRow } from '../api/types'
import { planSummary } from './planSummary'

const T0 = Date.parse('2026-10-10T14:00:00Z') / 1000 // 17:00 in Tallinn

function plan(batt: number[], soc: number[]): PlanRow[] {
  return batt.map((p, i) => ({
    timestamp: new Date((T0 + i * 900) * 1000).toISOString(),
    P_batt: p,
    SOC_opt: soc[i] ?? null,
  }))
}

describe('planSummary', () => {
  it('says what the battery does until that changes, and where the SOC goes', () => {
    const rows = plan([2400, 2500, 2600, 0, 0], [0.94, 0.82, 0.7, 0.7, 0.7])
    expect(planSummary(rows, T0 + 60, 'Europe/Tallinn')).toBe(
      'Discharging the battery until 17:45, then idle · SOC 94 % → 70 %',
    )
  })

  it('starts from the slot in force now and takes the SOC at the end of the slot before', () => {
    const rows = plan([0, -3000, -3000, 1000], [0.5, 0.6, 0.7, 0.65])
    expect(planSummary(rows, T0 + 900 + 30, 'Europe/Tallinn')).toBe(
      'Charging the battery until 17:45, then discharging · SOC 50 % → 70 %',
    )
  })

  it('treats a few watts as idle and shows one SOC', () => {
    const rows = plan([40, -30, 2000], [0.8, 0.8, 0.7])
    expect(planSummary(rows, T0, 'Europe/Tallinn')).toBe('Battery idle until 17:30, then discharging · SOC 80 %')
  })

  it('runs to the end of the plan when nothing changes', () => {
    const rows = plan([-2000, -2000], [0.5, 0.6])
    expect(planSummary(rows, T0, 'Europe/Tallinn')).toBe(
      'Charging the battery to the end of the plan · SOC 50 % → 60 %',
    )
  })

  it('gives up without battery power or rows ahead', () => {
    expect(planSummary([], T0, 'Europe/Tallinn')).toBeNull()
    expect(planSummary(plan([1000], [0.5]), T0 + 3600, 'Europe/Tallinn')).toBeNull()
    expect(planSummary([{ timestamp: new Date(T0 * 1000).toISOString() }], T0, 'Europe/Tallinn')).toBeNull()
  })
})
