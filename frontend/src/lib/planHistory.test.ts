import { describe, expect, it, vi } from 'vitest'
import type { HistorySlot, PlanPrice } from '../api/types'
import {
  closeSteps,
  loadPref,
  mergePrices,
  pastAndFuture,
  pastEnd,
  pastShade,
  plannedAtTheTime,
  savePref,
  timeGrid,
  windowLabel,
} from './planHistory'

const t0 = Date.parse('2026-10-09T10:00:00Z') / 1000
const at = (i: number) => new Date((t0 + i * 900) * 1000).toISOString()

function slot(i: number, actual: Partial<HistorySlot['actual']>, planned: Partial<HistorySlot['planned']>): HistorySlot {
  return {
    start: at(i),
    planned: { P_grid: null, P_batt: null, P_PV: null, P_Load: null, P_deferrable: null, SOC: null, ...planned },
    planned_at: null,
    actual: { grid: null, batt: null, pv: null, load: null, soc: null, ...actual },
  }
}

const history = [slot(0, { load: 1400, soc: 0.6 }, { P_Load: 1500, SOC: 0.62 }), slot(1, { load: 1600 }, { P_Load: 1500 })]
const rows = [
  { timestamp: at(2), P_Load: 1700, SOC_opt: 0.7 },
  { timestamp: at(3), P_Load: 1800, SOC_opt: 0.75 },
]

describe('plan history series', () => {
  it('builds one grid from history slots and plan rows, with a closing point', () => {
    expect(timeGrid(history, rows)).toEqual([t0, t0 + 900, t0 + 1800, t0 + 2700, t0 + 3600])
    expect(timeGrid([], [])).toEqual([])
  })

  it('ends the past after the last history slot, or at the current slot without history', () => {
    expect(pastEnd(history, t0 + 5000)).toBe(t0 + 1800)
    expect(pastEnd([], t0 + 1000)).toBe(t0 + 900)
  })

  it('joins measured values and the plan into one series, measured first', () => {
    const x = timeGrid(history, rows)
    expect(pastAndFuture(x, history, 'load', rows, 'P_Load', t0 + 1800)).toEqual([1400, 1600, 1700, 1800, 1800])
    // a plan row inside the past is ignored: the measurement is the truth there
    const stale = [{ timestamp: at(1), P_Load: 9999 }, ...rows]
    expect(pastAndFuture(x, history, 'load', stale, 'P_Load', t0 + 1800)).toEqual([1400, 1600, 1700, 1800, 1800])
    // a quantity without a sensor has an empty past
    expect(pastAndFuture(x, history, null, rows, 'P_Load', t0 + 1800)).toEqual([null, null, 1700, 1800, 1800])
    // scaling (SOC to %); a line series (not stepped) gets no closing point
    expect(pastAndFuture(x, history, 'soc', rows, 'SOC_opt', t0 + 1800, 100, false)).toEqual([60, null, 70, 75, null])
  })

  it('draws what the plan said only in the past, closed one step further', () => {
    const x = timeGrid(history, rows)
    expect(plannedAtTheTime(x, history, 'P_Load')).toEqual([1500, 1500, 1500, null, null])
    expect(plannedAtTheTime(x, history, 'SOC', 100, false)).toEqual([62, null, null, null, null])
  })

  it('closes step series without inventing values after a gap', () => {
    expect(closeSteps([1, 2, null, null])).toEqual([1, 2, 2, null])
    expect(closeSteps([null, null])).toEqual([null, null])
    expect(closeSteps([1])).toEqual([1])
  })

  it('merges past and future prices, the past winning on a shared slot', () => {
    const price = (i: number, imp: number, origin = 'actual'): PlanPrice => ({ start: at(i), import_price: imp, export_price: 0, origin })
    const merged = mergePrices([price(0, 0.1), price(1, 0.2)], [price(1, 0.9, 'forecast:x'), price(2, 0.3, 'forecast:x')])
    expect(merged.map((p) => [p.start, p.import_price])).toEqual([
      [at(0), 0.1],
      [at(1), 0.2],
      [at(2), 0.3],
    ])
  })

  it('shades the past from the first point to where the past ends', () => {
    expect(pastShade([t0, t0 + 900, t0 + 1800], t0 + 1800)).toEqual([[t0, t0 + 1800]])
    expect(pastShade([t0 + 1800], t0 + 1800)).toEqual([])
  })

  it('labels windows in hours or days', () => {
    expect(windowLabel(6)).toBe('6 h')
    expect(windowLabel(24)).toBe('24 h')
    expect(windowLabel(168)).toBe('7 d')
  })

  it('remembers a choice and falls back on junk or blocked storage', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    })
    try {
      savePref('test.pref', 48)
      expect(loadPref('test.pref', [6, 24, 48] as const, 24)).toBe(48)
      store.set('test.pref', 'nope')
      expect(loadPref('test.pref', [6, 24, 48] as const, 24)).toBe(24)
      vi.stubGlobal('localStorage', {
        getItem: () => {
          throw new Error('blocked')
        },
        setItem: () => {
          throw new Error('blocked')
        },
      })
      savePref('test.pref', 6)
      expect(loadPref('test.pref', [6, 24, 48] as const, 6)).toBe(6)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
