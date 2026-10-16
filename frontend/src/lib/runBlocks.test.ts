import { describe, expect, it } from 'vitest'
import { blockAt, runBlocks } from './runBlocks'

const at = (s: number) => new Date(s * 1000).toISOString()

describe('runBlocks', () => {
  const runs = [
    { id: 3, started_at: at(1800 + 660), outcome: 'error' },
    { id: 1, started_at: at(660), outcome: 'ok' },
    { id: 2, started_at: at(900 + 660), outcome: 'ok' },
    { id: 4, started_at: at(1800 + 700), outcome: 'ok' }, // a retry right after the error
  ]

  it('runs each block to the next start, a quarter-hour at most, and outlines the next run', () => {
    const blocks = runBlocks(runs, 2700 + 660)
    expect(blocks.map((b) => [b.id, b.from, b.to, b.color])).toEqual([
      [1, 660, 1560, '--lamp-green'],
      [2, 1560, 2460, '--lamp-green'],
      [3, 2460, 2500, '--lamp-red'],
      [4, 2500, 3360, '--lamp-green'],
      [null, 3360, 4260, '--lamp-green'],
    ])
    expect(blocks[2]?.label).toBe('run #3 · Error')
    expect(blocks[4]?.outline).toBe(true)
  })

  it('finds the block at a time', () => {
    const blocks = runBlocks(runs, null)
    expect(blockAt(blocks, 2470)?.id).toBe(3)
    expect(blockAt(blocks, 100)).toBeNull()
  })
})
