import { describe, expect, it } from 'vitest'
import { alignTo, deferrableColumns, planChanges, rowAt, stepSeries } from './plan'

const t0 = Date.parse('2026-10-09T11:15:00Z') / 1000
const row = (i: number, batt: number, grid: number, soc = 0.5) => ({
  timestamp: new Date((t0 + i * 900) * 1000).toISOString(),
  P_batt: batt,
  P_grid: grid,
  SOC_opt: soc,
})

describe('plan helpers', () => {
  it('finds the row of the slot that contains now', () => {
    const rows = [row(0, 0, 0), row(1, 100, 0)]
    expect(rowAt(rows, t0 + 899)?.P_batt).toBe(0)
    expect(rowAt(rows, t0 + 900)?.P_batt).toBe(100)
    expect(rowAt(rows, t0 - 1)).toBeNull()
  })

  it('lists slots where battery or grid moved more than the threshold', () => {
    const current = [row(0, 0, 1000), row(1, -3000, 4000), row(2, 0, 0)]
    const previous = [row(0, 0, 1200), row(1, 0, 1000), row(3, 5000, 0)]
    const changes = planChanges(current, previous)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ battNow: -3000, battBefore: 0, gridNow: 4000, gridBefore: 1000 })
  })

  it('orders deferrable columns numerically', () => {
    expect(deferrableColumns(['P_deferrable10', 'P_PV', 'P_deferrable2', 'P_deferrable0'])).toEqual([
      'P_deferrable0',
      'P_deferrable2',
      'P_deferrable10',
    ])
  })

  it('adds a closing point so the last step has a width, and aligns the previous plan', () => {
    const { x, ys } = stepSeries([row(0, 1, 2), row(1, 3, 4)], ['P_batt', 'missing'])
    expect(x).toEqual([t0, t0 + 900, t0 + 1800])
    expect(ys[0]).toEqual([1, 3, 3])
    expect(ys[1]).toEqual([null, null, null])
    expect(alignTo(x, [row(1, 0, 0, 0.7)], 'SOC_opt')).toEqual([null, 0.7, null])
  })
})
