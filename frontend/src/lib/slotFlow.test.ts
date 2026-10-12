import { describe, expect, it } from 'vitest'
import type { NowQuantity, PlanPrice } from '../api/types'
import { byKey } from './planNow'
import {
  agreement,
  flowHeadline,
  flowNodes,
  flowSegments,
  measuredValues,
  NARROW_FLOW,
  planValues,
  priceInDay,
  segmentBox,
  shortAge,
  WIDE_FLOW,
  type FlowValues,
} from './slotFlow'

const q = (key: string, measured: number | null, extra: Partial<NowQuantity> = {}): NowQuantity => ({ key, measured, sign_hint: false, ...extra })
const v = (pv: number, grid: number, batt: number, load: number, ev: number | null = 0): FlowValues => ({ pv, grid, batt, load, ev })

// run 2791's slot (02:00): Force charge, the grid charging the battery and running the house
const NIGHT = v(0, 12685, -10638, 2047)
const COLUMNS = ['P_PV', 'P_grid', 'P_batt', 'P_Load', 'P_deferrable0', 'SOC_opt', 'unit_load_cost']

describe('the slot in one line', () => {
  it('says where the power goes', () => {
    expect(flowHeadline(NIGHT)).toBe('Charging the battery from the grid')
    expect(flowHeadline(v(11800, -3500, -3000, 1200, 4100))).toBe(
      'Charging the battery and the EV from PV, exporting the rest',
    )
    expect(flowHeadline(v(6000, 1500, -6800, 700))).toBe('Charging the battery from PV and the grid')
    expect(flowHeadline(v(0, -10200, 12000, 1800))).toBe('Discharging the battery to the grid')
    expect(flowHeadline(v(0, 0, 2400, 2400))).toBe('The battery covers the house')
    expect(flowHeadline(v(0, 2310, 90, 2400))).toBe('The grid covers the house')
    expect(flowHeadline(v(0, 4000, 0, 900, 3100), 'the deferrable load')).toBe(
      'The grid covers the house and the deferrable load',
    )
    expect(flowHeadline(v(3000, -2000, 0, 1000))).toBe('PV covers the house, exporting the rest')
    expect(flowHeadline(v(40, 60, -30, 70))).toBe('Nothing flows') // EMHASS's few watts of noise
  })
})

describe('judged against the plan', () => {
  it('names what differs, or says as planned', () => {
    expect(agreement(byKey([q('batt', 1, { differs: false }), q('grid', 1, { differs: false })]))).toEqual({
      color: 'green',
      text: 'as planned',
    })
    const off = byKey([q('batt', 1, { differs: true }), q('grid', 1, { differs: true }), q('soc', 0.1, { differs: true })])
    expect(agreement(off)).toEqual({ color: 'amber', text: 'Battery, grid and SOC differ from the plan' })
    expect(agreement(byKey([q('grid', 1, { differs: true }), q('pv', 1)]))?.text).toBe('Grid differs from the plan')
    expect(agreement(byKey([q('pv', 1), q('load', 1)]))).toBeNull() // forecasts are never judged
    expect(agreement(undefined)).toBeNull()
  })
})

describe('the boxes', () => {
  it('reads the plan row, the deferrable loads together, and the charger as the EV now', () => {
    const row = { P_PV: 0, P_grid: 12685, P_batt: -10638, P_Load: 2047, P_deferrable0: 0, P_deferrable1: 1500 }
    expect(planValues(row, [...COLUMNS, 'P_deferrable1'])).toEqual({ ...NIGHT, ev: 1500 })
    expect(planValues(row, ['P_PV', 'P_grid']).ev).toBeNull()
    const now = byKey([q('grid', 12510), q('batt', -10420), q('pv', null), q('load', 2090)])
    expect(measuredValues(now, { state_raw: 4, current_limit_a: 6, power_w: 4140 })).toEqual({
      pv: null,
      grid: 12510,
      batt: -10420,
      load: 2090,
      ev: 4140,
    })
  })

  it('shows what is measured big, with the plan under it', () => {
    const nodes = flowNodes(NIGHT, v(0, 12510, -10420, 2090, null), { deferrable: 'EV' })
    const by = Object.fromEntries(nodes.map((n) => [n.key, n]))
    expect(by.grid).toMatchObject({ value: '12.51 kW', direction: 'importing', measured: true, plan: 'plan 12.69 kW' })
    expect(by.batt).toMatchObject({ value: '10.42 kW', direction: 'charging', plan: 'plan 10.64 kW' })
    expect(by.load).toMatchObject({ value: '2.09 kW', direction: '', plan: 'forecast 2.05 kW' })
    expect(by.pv).toMatchObject({ value: '0 W', direction: 'not producing', idle: true })
    // no charger power: the plan is the big number, and says so
    expect(by.ev).toMatchObject({ label: 'EV', value: '0 W', measured: false, plan: 'planned', direction: 'off' })
  })

  it('adds the plan direction when reality runs the other way, and the charger state for the EV', () => {
    const nodes = flowNodes(v(0, 0, 2400, 2400), v(0, 2310, 90, 2400, 4140), {
      deferrable: 'EV',
      charger: { state_raw: 4, current_limit_a: 6, power_w: 4140 },
    })
    const by = Object.fromEntries(nodes.map((n) => [n.key, n]))
    expect(by.grid).toMatchObject({ value: '2.31 kW', direction: 'importing', plan: 'plan 0 W no flow' })
    expect(by.batt).toMatchObject({ value: '90 W', direction: 'idle', plan: 'plan 2.40 kW discharging' })
    expect(by.ev).toMatchObject({ value: '4.14 kW', direction: 'charging at 6 A', plan: 'plan 0 W off' })
    const unplugged = flowNodes(v(0, 0, 0, 900), v(0, 900, 0, 900, 0), {
      deferrable: 'EV',
      charger: { state_raw: 0, current_limit_a: 0, power_w: 0 },
    })
    expect(unplugged.find((n) => n.key === 'ev')).toMatchObject({ direction: 'unplugged', plan: 'plan 0 W' })
  })

  it('leaves the deferrable box out when the plan has none, and adds the curtailment to PV', () => {
    const measured = { pv: 8700, grid: null, batt: null, load: null, ev: null }
    const nodes = flowNodes(v(9000, -2000, 0, 1000, null), measured, {
      deferrable: null,
      curtailed: 1200,
    })
    expect(nodes.map((n) => n.key)).toEqual(['pv', 'grid', 'batt', 'load'])
    expect(nodes[0]!.plan).toBe('forecast 9.00 kW, 1.20 kW curtailed')
    expect(nodes[1]).toMatchObject({ value: '2.00 kW', direction: 'exporting', measured: false, plan: 'planned' })
  })
})

describe('the lines', () => {
  it('runs from each box to the middle, as thick as the power, pointing the way it flows', () => {
    const segments = flowSegments(NIGHT, WIDE_FLOW, true)
    const by = Object.fromEntries(segments.map((s) => [s.key, s]))
    expect(by.grid).toMatchObject({ from: [176, 194], to: [360, 194], watts: 12685, dir: 'r' })
    expect(by.batt).toMatchObject({ from: [360, 194], to: [544, 194], watts: 10638, dir: 'r' }) // into the battery
    expect(by.users).toMatchObject({ watts: 2047, arrow: false })
    expect(by.load).toMatchObject({ from: [256, 252], to: [256, 300], dir: 'd' })
    expect(by.ev).toMatchObject({ from: [464, 252], to: [464, 300], watts: 0 })

    const grid = segmentBox(by.grid!, WIDE_FLOW)
    expect(grid.idle).toBe(false)
    expect(grid.line).toEqual({ left: 170.5, top: 188.5, width: 195, height: 11 }) // 3 + 13 × 12.685 / 20 px
    expect(grid.arrow).toMatchObject({ width: 11, height: 21, clip: 'polygon(0 0, 100% 50%, 0 100%)' })
    expect(segmentBox(by.ev!, WIDE_FLOW)).toEqual({ line: { left: 464, top: 252, width: 0, height: 48 }, idle: true, arrow: null })

    const discharging = flowSegments(v(0, -10200, 12000, 1800), NARROW_FLOW, false)
    expect(discharging.find((s) => s.key === 'batt')?.dir).toBe('l')
    expect(discharging.find((s) => s.key === 'grid')?.dir).toBe('l')
    expect(discharging.find((s) => s.key === 'load')).toMatchObject({ from: [164, 172], to: [164, 268] })
  })
})

describe('ages and prices', () => {
  it('keeps an age short', () => {
    expect(shortAge(12.4)).toBe('12 s')
    expect(shortAge(-3)).toBe('0 s')
    expect(shortAge(150)).toBe('2 min')
    expect(shortAge(3 * 3600 + 5)).toBe('3 h')
    expect(shortAge(2 * 86400)).toBe('2 d')
  })

  it('places the import price within its own day', () => {
    const price = (start: string, import_price: number): PlanPrice => ({ start, import_price, export_price: 0, origin: 'nordpool' })
    const prices = [
      price('2026-10-11T20:00:00Z', 0.5), // 23:00 the day before in Tallinn
      price('2026-10-12T00:00:00Z', 0.079),
      price('2026-10-12T09:30:00Z', 0.1532),
      price('2026-10-12T16:00:00Z', 0.2964),
    ]
    const day = priceInDay(prices, '2026-10-12T09:30:00Z', 0.1532, 'Europe/Tallinn')
    expect(day).toMatchObject({ min: 0.079, max: 0.2964, word: 'mid-range for today' })
    expect(day!.position).toBeCloseTo(0.341, 3)
    expect(priceInDay(prices, '2026-10-12T00:00:00Z', 0.079, 'Europe/Tallinn')?.word).toBe('cheap for today')
    expect(priceInDay(prices.slice(0, 1), '2026-10-12T09:30:00Z', 0.15, 'Europe/Tallinn')).toBeNull()
    expect(priceInDay(prices, '2026-10-12T09:30:00Z', null)).toBeNull()
  })
})
