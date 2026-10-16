import { describe, expect, it } from 'vitest'
import { tableAround } from './planTable'

const x = Array.from({ length: 41 }, (_, i) => i * 900)
const ramp = x.map((_, i) => i * 100)
const cols = { grid: ramp, pv: null, load: null, battery: ramp.map((v) => -v), soc: ramp.map((v) => v / 100) }
const prices = new Map([[9000, { import: 0.15, export: 0.05 }]])

describe('tableAround', () => {
  it('gives 24 quarter-hours around the cursor, the cursor\'s marked, the battery as + charge', () => {
    const rows = tableAround(10 * 900 + 100, x, cols, prices, 12 * 900, 24)
    expect(rows).toHaveLength(24)
    expect(rows[0]?.t).toBe(0)
    const current = rows.find((r) => r.current)
    expect(current).toMatchObject({ t: 9000, grid: 1000, battery: 1000, soc: 10, import: 0.15, export: 0.05 })
    expect(rows.filter((r) => r.measured).map((r) => r.t)).toEqual(x.slice(0, 12))
  })

  it('keeps the rows inside the grid at its ends', () => {
    const rows = tableAround(39 * 900, x, cols, prices, 0, 24)
    expect(rows[rows.length - 1]?.t).toBe(39 * 900)
    expect(rows).toHaveLength(24)
    expect(tableAround(0, [0], cols, prices, 0)).toEqual([])
  })
})
