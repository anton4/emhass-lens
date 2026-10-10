import { describe, expect, it } from 'vitest'
import { eurTick, formatPrice } from './units'

describe('prices in €/kWh', () => {
  it('formats axis ticks without trailing zeros and values with four decimals', () => {
    expect(eurTick(0.05)).toBe('0.05 €')
    expect(eurTick(0.1)).toBe('0.1 €')
    expect(eurTick(0.125)).toBe('0.125 €')
    expect(eurTick(-0.02)).toBe('-0.02 €')
    expect(eurTick(0.30000000000000004)).toBe('0.3 €')
    expect(formatPrice(0.0904)).toBe('0.0904 €/kWh')
  })
})
