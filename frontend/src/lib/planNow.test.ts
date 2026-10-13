import { describe, expect, it } from 'vitest'
import type { NowQuantity } from '../api/types'
import { byKey, evSensor, expectedText, inverterParts, powerDiffers } from './planNow'

const q = (key: string, measured: number | null, extra: Partial<NowQuantity> = {}): NowQuantity => ({ key, measured, sign_hint: false, ...extra })

describe('this slot, measured now', () => {
  it('keys the quantities and words what the battery is expected to do', () => {
    expect(byKey([q('grid', 1), q('soc', 0.5)]).soc?.measured).toBe(0.5)
    const batt = q('batt', 720, { expected: 744, entity: 'sensor.batt', age_s: 20 })
    expect(expectedText(batt)).toBe('expected 744 W discharging with the house load and PV now')
    expect(expectedText(batt, true)).toBe('expected 744 W discharging with the measured house load and PV')
    const grid = q('grid', -4250, { expected: -4442 })
    expect(expectedText(grid)).toBe('expected 4.44 kW exporting with the house load and PV now')
    expect(expectedText(q('grid', 1))).toBeNull()
    expect(expectedText(q('pv', 1, { expected: 5 }))).toBeNull()
  })

  it('dates the EV box by the charger entity its power last changed from', () => {
    expect(evSensor(null)).toBeUndefined()
    expect(evSensor({ power_w: 0, state_raw: 1 })).toBeUndefined()
    const ev = evSensor({ power_w: 5520, state_raw: 4, entity: 'number.limit', age_s: 120 })
    expect(ev).toMatchObject({ key: 'ev', entity: 'number.limit', age_s: 120 })
    expect(expectedText(ev)).toBeNull()
    expect(ev?.differs).toBeUndefined()
  })

  it('counts a power as off by the backend rule: over 300 W and 15 %', () => {
    expect(powerDiffers(-2920, -4442)).toBe(true)
    expect(powerDiffers(5000, 5600)).toBe(false) // 600 W, but only 11 %
    expect(powerDiffers(0, 250)).toBe(false)
    expect(powerDiffers(null, 100)).toBe(false)
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
