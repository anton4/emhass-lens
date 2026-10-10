import { describe, expect, it } from 'vitest'
import { matchesSearch, nextSort, sortRows } from './sort'

describe('sortRows', () => {
  const rows = [
    { id: 1, v: 3 },
    { id: 2, v: null },
    { id: 3, v: 1 },
    { id: 4, v: 3 },
  ]
  it('sorts both ways with unknown values last and ties in their original order', () => {
    expect(sortRows(rows, (r) => r.v, 'asc').map((r) => r.id)).toEqual([3, 1, 4, 2])
    expect(sortRows(rows, (r) => r.v, 'desc').map((r) => r.id)).toEqual([1, 4, 3, 2])
  })
  it('sorts text', () => {
    expect(sortRows(['solar_adjust', 'cheap', 'none'], (r) => r, 'asc')).toEqual(['cheap', 'none', 'solar_adjust'])
  })
  it('leaves the input alone', () => {
    sortRows(rows, (r) => r.v, 'asc')
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4])
  })
})

describe('nextSort', () => {
  it('flips the same column and starts a new one in its first direction', () => {
    expect(nextSort({ key: 'at', dir: 'desc' }, 'at')).toEqual({ key: 'at', dir: 'asc' })
    expect(nextSort({ key: 'at', dir: 'asc' }, 'at')).toEqual({ key: 'at', dir: 'desc' })
    expect(nextSort({ key: 'at', dir: 'desc' }, 'rule', 'asc')).toEqual({ key: 'rule', dir: 'asc' })
  })
})

describe('matchesSearch', () => {
  it('needs every word somewhere, ignoring case', () => {
    expect(matchesSearch(['Excess solar: adjust the current', null], 'solar CURRENT')).toBe(true)
    expect(matchesSearch(['Excess solar', 'mismatch'], 'solar cheap')).toBe(false)
    expect(matchesSearch([undefined], '  ')).toBe(true)
  })
})
