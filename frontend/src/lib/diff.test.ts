import { describe, expect, it } from 'vitest'
import { deepEqual, diffDocs } from './diff'

describe('diffDocs', () => {
  it('reports leaf changes with dotted paths', () => {
    const old = { emhass: { mode: 'off', mpc: { auto: false } }, prices: { tariff: { vat_pct: 24 } } }
    const next = { emhass: { mode: 'live', mpc: { auto: false } }, prices: { tariff: { vat_pct: 22 } } }
    expect(diffDocs(old, next)).toEqual([
      { path: 'emhass.mode', old: 'off', new: 'live' },
      { path: 'prices.tariff.vat_pct', old: 24, new: 22 },
    ])
  })

  it('compares lists as whole values', () => {
    const old = { loads: [{ name: 'EV', w: 11000 }] }
    const next = { loads: [{ name: 'EV', w: 7400 }] }
    expect(diffDocs(old, next)).toEqual([{ path: 'loads', old: old.loads, new: next.loads }])
    expect(diffDocs(old, { loads: [{ name: 'EV', w: 11000 }] })).toEqual([])
  })

  it('handles added and removed keys and nulls', () => {
    expect(diffDocs({ a: 1 }, { b: 2 })).toEqual([
      { path: 'a', old: 1, new: null },
      { path: 'b', old: null, new: 2 },
    ])
    expect(diffDocs({ a: null }, { a: 0.03 })).toEqual([{ path: 'a', old: null, new: 0.03 }])
  })

  it('deepEqual', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
    expect(deepEqual({ a: [1] }, { a: [1, 2] })).toBe(false)
  })
})
