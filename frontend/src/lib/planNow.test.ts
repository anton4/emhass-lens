import { describe, expect, it } from 'vitest'
import type { NowQuantity } from '../api/types'
import { byKey, chargerText, inverterParts, measuredText, measuredTitle } from './planNow'

const q = (key: string, measured: number | null, extra: Partial<NowQuantity> = {}): NowQuantity => ({ key, measured, ...extra })

describe('this slot, measured now', () => {
  it('words the measured value like the plan tile', () => {
    expect(measuredText(q('batt', 120))).toBe('now 120 W discharging')
    expect(measuredText(q('batt', -2500))).toBe('now 2.50 kW charging')
    expect(measuredText(q('grid', 1790))).toBe('now 1.79 kW importing')
    expect(measuredText(q('pv', 312))).toBe('now 312 W')
    expect(measuredText(q('soc', 0.923))).toBe('now 92.3 %')
    expect(measuredText(q('load', null))).toBeNull()
    expect(measuredText(undefined)).toBeNull()
    expect(measuredTitle(q('batt', 1, { entity: 'sensor.batt', age_s: 20 }))).toBe('sensor.batt, 20 s old')
    expect(byKey([q('grid', 1), q('soc', 0.5)]).soc?.measured).toBe(0.5)
  })

  it('lists what the inverter is set to and what the charger does', () => {
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
    expect(chargerText({ state_raw: 4, current_limit_a: 8 })).toBe('EV charging at 8 A')
    expect(chargerText({ state_raw: 1, current_limit_a: 0 })).toBe('EV plugged in, not charging')
    expect(chargerText(null)).toBeNull()
  })
})
