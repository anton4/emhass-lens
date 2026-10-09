import { describe, expect, it } from 'vitest'
import { batteryText, gridText, inCurrentSlot } from './publish'

describe('plan value wording', () => {
  it('follows the EMHASS sign convention', () => {
    expect(batteryText(946.4)).toBe('discharges 0.9 kW')
    expect(batteryText(-11143)).toBe('charges 11.1 kW')
    expect(batteryText(10)).toBe('idle')
    expect(gridText(1500)).toBe('imports 1.5 kW')
    expect(gridText(-15500)).toBe('exports 15.5 kW')
    expect(gridText(null)).toBe('—')
  })
})

describe('inCurrentSlot', () => {
  const now = new Date('2026-10-09T14:52:10Z')
  it('is true only within the quarter-hour that contains now', () => {
    expect(inCurrentSlot('2026-10-09T14:45:02Z', now)).toBe(true)
    expect(inCurrentSlot('2026-10-09T14:44:59Z', now)).toBe(false)
    expect(inCurrentSlot('2026-10-09T15:00:00Z', now)).toBe(false)
    expect(inCurrentSlot(null, now)).toBe(false)
  })
})
