import { describe, expect, it } from 'vitest'
import { energyIn, formatKwh, socSummary } from './planTotals'

const x = [0, 900, 1800, 2700]
const grid = [4000, -2000, 1000, null]

describe('energyIn', () => {
  it('adds up import, export or everything over the window', () => {
    expect(energyIn(x, grid, [0, 2700], 1)).toBeCloseTo(1.25)
    expect(energyIn(x, grid, [0, 2700], -1)).toBeCloseTo(0.5)
    expect(energyIn(x, grid, [0, 2700], 0)).toBeCloseTo(0.75)
  })

  it('counts the part of a slot the window cuts', () => {
    expect(energyIn(x, grid, [450, 900], 1)).toBeCloseTo(0.5)
    expect(energyIn(x, grid, [5000, 6000], 0)).toBe(0)
  })
})

describe('socSummary', () => {
  it('finds the value now and at the end', () => {
    expect(socSummary(x, [50, 55, null, 70], 1000)).toEqual({ now: 55, end: 70 })
    expect(socSummary(x, [null, null, null, null], 1000)).toEqual({ now: null, end: null })
  })
})

describe('formatKwh', () => {
  it('has one decimal, none from 100', () => {
    expect(formatKwh(12.44)).toBe('12.4 kWh')
    expect(formatKwh(123.4)).toBe('123 kWh')
  })
})
