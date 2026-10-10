import { describe, expect, it, vi } from 'vitest'
import type { CostfunResult } from '../api/types'
import { cheapest, compareGrid, formatEur, isMethod, loadQuantity, loadShown, methodSeries, saveQuantity, saveShown } from './costfun'

const t0 = Date.parse('2026-10-09T11:15:00Z') / 1000
const at = (i: number) => new Date((t0 + i * 900) * 1000).toISOString()

function result(costfun: string, net: number | null, rows: Record<string, unknown>[] = []): CostfunResult {
  return {
    costfun,
    label: costfun,
    live: costfun === 'profit',
    optim_status: 'ok',
    duration_ms: 10,
    problem: null,
    generated_at: null,
    totals:
      net === null
        ? null
        : {
            slots: rows.length,
            hours: rows.length / 4,
            import_kwh: 1,
            export_kwh: 0,
            import_cost_eur: net,
            export_revenue_eur: 0,
            net_cost_eur: net,
            pv_kwh: 0,
            load_kwh: 1,
            self_consumption_kwh: 0,
            self_consumption_pct: null,
            battery_charge_kwh: 0,
            battery_discharge_kwh: 0,
            soc_end: null,
            emhass_cost_profit_eur: null,
            emhass_objective: null,
            emhass_objective_column: null,
          },
    rows,
  }
}

describe('cost function comparison helpers', () => {
  const profit = result('profit', 1.2, [
    { timestamp: at(0), P_grid: 1000, P_batt: -500, SOC_opt: 0.5, P_deferrable0: 100, P_deferrable1: 50 },
    { timestamp: at(1), P_grid: 2000, P_batt: 0, SOC_opt: 0.75, P_deferrable0: 0, P_deferrable1: 0 },
  ])
  const cost = result('cost', 0.9, [{ timestamp: at(0), P_grid: 500, P_batt: 0, SOC_opt: 0.5 }])

  it('builds one grid over all compared plans with a closing point', () => {
    expect(compareGrid([profit, cost])).toEqual([t0, t0 + 900, t0 + 1800])
    expect(compareGrid([])).toEqual([])
  })

  it('reads a quantity per method, SOC in percent and deferrables summed', () => {
    const x = compareGrid([profit, cost])
    expect(methodSeries(x, profit, 'P_grid')).toEqual([1000, 2000, 2000])
    expect(methodSeries(x, cost, 'P_grid')).toEqual([500, 500, null])
    expect(methodSeries(x, profit, 'SOC_opt')).toEqual([50, 75, null])
    expect(methodSeries(x, profit, 'P_deferrable')).toEqual([150, 0, 0])
    expect(methodSeries(x, cost, 'P_deferrable')).toEqual([null, null, null])
  })

  it('finds the cheapest method, only when at least two produced a plan', () => {
    expect(cheapest([profit, cost])).toBe('cost')
    expect(cheapest([profit, result('cost', null)])).toBeNull()
    expect(cheapest([profit, cost, result('self-consumption', 0.1)])).toBe('self-consumption')
  })

  it('formats money and checks method names', () => {
    expect(formatEur(1.234)).toBe('1.23 €')
    expect(formatEur(1.234, true)).toBe('+1.23 €')
    expect(formatEur(-0.5, true)).toBe('-0.50 €')
    expect(formatEur(null)).toBe('—')
    expect(isMethod('cost')).toBe(true)
    expect(isMethod('bogus')).toBe(false)
  })

  it('remembers which methods and quantity are shown', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    })
    try {
      expect([...loadShown()]).toEqual(['profit', 'cost', 'self-consumption'])
      saveShown(new Set(['cost']))
      expect([...loadShown()]).toEqual(['cost'])
      expect(loadQuantity()).toBe('P_grid')
      saveQuantity('SOC_opt')
      expect(loadQuantity()).toBe('SOC_opt')
      store.set('emhass-lens.costfun.quantity', 'nonsense')
      expect(loadQuantity()).toBe('P_grid')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
