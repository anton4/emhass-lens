import { describe, expect, it } from 'vitest'
import type { HistorySlot, PlanPrice } from '../api/types'
import { balanceSeries, forecastBands, planFlows, powerSeries, priceSeries, socSeries } from './planSeries'
import { timeGrid } from './planHistory'

const t0 = Date.parse('2026-10-16T10:00:00Z') / 1000
const at = (i: number) => new Date((t0 + i * 900) * 1000).toISOString()

function slot(i: number, actual: Partial<HistorySlot['actual']>, planned: Partial<HistorySlot['planned']>): HistorySlot {
  return {
    start: at(i),
    planned: { P_grid: null, P_batt: null, P_PV: null, P_Load: null, P_deferrable: null, SOC: null, ...planned },
    planned_at: null,
    actual: { grid: null, batt: null, pv: null, load: null, soc: null, ...actual },
  }
}

const past = [
  slot(0, { grid: 500, pv: 2000, load: 1500, batt: -1000, soc: 0.5 }, { P_grid: 300, SOC: 0.52 }),
  slot(1, { grid: -200, pv: 2500, load: 1300, batt: -1000, soc: 0.55 }, { P_grid: 0, SOC: 0.56 }),
]
const rows = [
  { timestamp: at(2), P_grid: 100, P_PV: 2400, P_Load: 1400, P_batt: -1100, SOC_opt: 0.6, P_deferrable0: 0 },
  { timestamp: at(3), P_grid: 2100, P_PV: 0, P_Load: 1400, P_batt: 0, SOC_opt: 0.6, P_deferrable0: 700 },
]
const columns = Object.keys(rows[0]!)
const x = timeGrid(past, rows)
const pastEndS = t0 + 2 * 900

describe('planFlows', () => {
  it('has each flow measured left of now and planned right of it', () => {
    const flows = planFlows(x, past, rows, pastEndS, columns)
    expect(flows.grid?.slice(0, 4)).toEqual([500, -200, 100, 2100])
    expect(flows.gridThen?.slice(0, 2)).toEqual([300, 0])
    expect(flows.deferrable?.slice(2, 4)).toEqual([0, 700])
    expect(flows.deferrableLabel).toBe('Deferrable load')
  })
})

describe('socSeries', () => {
  it('draws the measured SOC on into the plan, fainter there, with the plan at the time in grey', () => {
    const series = socSeries(x, past, rows, [], pastEndS, columns)
    expect(series?.map((s) => s.label)).toEqual(['Battery SOC', 'Planned at the time'])
    expect(series?.[0]?.fade).toEqual({ line: 0.5 })
    expect(series?.[1]).toMatchObject({ color: '--chart-then', then: true })
    expect(series?.[0]?.values.slice(0, 3).map((v) => (v === null ? null : Math.round(v)))).toEqual([50, 55, 60])
  })

  it('is null with nothing to draw', () => {
    expect(socSeries(x, [], [], [], pastEndS, [])).toBeNull()
  })
})

describe('powerSeries', () => {
  const flows = planFlows(x, past, rows, pastEndS, columns)

  it('stacks the flows, faded right of now, with the grid on top as the popup lead', () => {
    const series = powerSeries({ x, flows, hidden: () => false, cover: null, pastEndS, nowS: pastEndS, gridData: undefined })
    const grid = series.find((s) => s.label === 'Grid')
    expect(grid).toMatchObject({ lead: true, fade: { line: 0.6 } })
    expect(series.find((s) => s.label === 'PV')?.fade).toBeDefined()
    expect(series[series.length - 1]).toMatchObject({ label: 'Grid, planned at the time', then: true })
  })

  it('leaves out the parts hidden', () => {
    const series = powerSeries({
      x,
      flows,
      hidden: (part) => part === 'grid' || part === 'pv',
      cover: null,
      pastEndS,
      nowS: pastEndS,
      gridData: undefined,
    })
    expect(series.some((s) => s.label === 'Grid' || s.label === 'PV')).toBe(false)
  })
})

describe('priceSeries', () => {
  const price = (i: number, origin: string): PlanPrice =>
    ({ start: at(i), import_price: 0.1 + i / 100, export_price: 0.05, origin }) as PlanPrice

  it('merges the past and the plan, with a closing point and the forecast stretch', () => {
    const out = priceSeries([price(0, 'actual')], [price(1, 'actual'), price(2, 'forecast:ee_eupowerprices')])
    expect(out?.x).toEqual([t0, t0 + 900, t0 + 1800, t0 + 2700])
    expect(out?.bands).toEqual([[t0 + 1800, t0 + 2700]])
    expect(out?.imports.map((p) => Math.round(p.value * 100) / 100)).toEqual([0.1, 0.11, 0.12])
    expect(out?.tag(t0 + 1800)?.tone).toBe('blue')
  })

  it('is null without prices', () => {
    expect(priceSeries([], [])).toBeNull()
  })

  it('joins back-to-back forecast slots into one band', () => {
    expect(forecastBands([price(0, 'forecast'), price(1, 'forecast'), price(3, 'forecast')])).toEqual([
      [t0, t0 + 1800],
      [t0 + 2700, t0 + 3600],
    ])
  })
})

describe('balanceSeries', () => {
  it('stacks the grid as a layer, one popup row for it in its own sign', () => {
    const flows = planFlows(x, past, rows, pastEndS, columns)
    const series = balanceSeries(flows)
    const grid = series.find((s) => s.label === 'Grid import')
    expect(grid).toMatchObject({ popupLabel: 'Grid', readout: flows.grid })
    expect(series.find((s) => s.label === 'Grid export')?.helper).toBe(true)
  })
})
