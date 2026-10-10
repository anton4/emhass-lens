import { describe, expect, it } from 'vitest'
import { evReserveText, formatEnergyWh } from './evReserve'

const active = {
  active: true,
  why: 'Excess Solar, car 50 % → 80 %, 22.5 kWh to go',
  energy_needed_wh: 22500,
  energy_reserved_wh: 22500,
  until: '2026-10-09T14:45:00.000+00:00',
  max_w: 8280,
  slots: 12,
  soc: 50,
  target_soc: 80,
}

describe('evReserveText', () => {
  it('formats energy', () => {
    expect(formatEnergyWh(800)).toBe('800 Wh')
    expect(formatEnergyWh(22500)).toBe('22.5 kWh')
  })

  it('says what was reserved, why nothing was, or nothing when the feature is off', () => {
    expect(evReserveText(null)).toBeNull()
    expect(evReserveText({ ...active, active: false, why: 'the car is unplugged' })).toBe(
      'No PV is reserved for the car: the car is unplugged.',
    )
    expect(evReserveText({ ...active, slots: 0, until: null, energy_reserved_wh: 0, max_w: 0 })).toBe(
      'Excess Solar, car 50 % → 80 %, 22.5 kWh to go; the forecast has no PV surplus to reserve.',
    )
    const text = evReserveText(active, 'Europe/Tallinn') ?? ''
    expect(text).toContain('22.5 kWh of PV is kept for the car over 12 slots, up to 8.28 kW a slot, until ')
    expect(text).toContain('17:45')
    expect(text.endsWith('EMHASS plans with the rest.')).toBe(true)
  })
})
