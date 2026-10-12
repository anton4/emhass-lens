import { describe, expect, it } from 'vitest'
import type { NowQuantity } from '../api/types'
import { byKey, expectedText, inverterParts } from './planNow'

const q = (key: string, measured: number | null, extra: Partial<NowQuantity> = {}): NowQuantity => ({ key, measured, sign_hint: false, ...extra })

describe('this slot, measured now', () => {
  it('keys the quantities and words what the battery is expected to do', () => {
    expect(byKey([q('grid', 1), q('soc', 0.5)]).soc?.measured).toBe(0.5)
    const batt = q('batt', 720, { expected: 744, entity: 'sensor.batt', age_s: 20 })
    expect(expectedText(batt)).toBe('expected 744 W discharging with the house load and PV now')
    expect(expectedText(batt, true)).toBe('expected 744 W discharging with the measured house load and PV')
    expect(expectedText(q('grid', 1, { expected: 5 }))).toBeNull()
  })

  it('lists what the inverter is set to', () => {
    expect(
      inverterParts({
        mode: 'live',
        in_control: true,
        charger_mode: 'Passive Mode',
        state: 'Self-use battery or PV',
        grid_power_w: 0,
        battery_min_w: -20000,
        battery_max_w: 20000,
        feedin_max_w: 0,
      }),
    ).toEqual(['Passive Mode · Self-use battery or PV', 'grid target 0 W', 'battery -20 … 20 kW', 'feed-in limit 0 W'])
  })
})
