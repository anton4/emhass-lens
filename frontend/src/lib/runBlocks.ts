// The MPC runs on the Plan page's time axis as blocks: each run from its start until the next one starts, at most a
// quarter-hour, coloured by its outcome; the next scheduled run as an outlined box.

import type { RunSummary } from '../api/types'
import { OUTCOMES, outcomeLabel } from './outcomes'

export interface RunBlock {
  from: number
  to: number
  /** CSS custom property of its colour. */
  color: string
  /** The run's id, or null for the next one, not run yet. */
  id: number | null
  /** "run #4554 · OK", "next run 15:41". */
  label: string
  outline?: boolean
}

/** The runs (any order) as blocks, oldest first, and the next run (unix s) outlined over its quarter-hour. */
export function runBlocks(runs: Pick<RunSummary, 'id' | 'started_at' | 'outcome'>[], nextRun: number | null, slotS = 900): RunBlock[] {
  const sorted = [...runs].map((r) => ({ ...r, t: Date.parse(r.started_at) / 1000 })).sort((a, b) => a.t - b.t)
  const blocks: RunBlock[] = sorted.map((r, i) => {
    const next = sorted[i + 1]?.t ?? nextRun ?? Infinity
    return {
      from: r.t,
      to: Math.min(next, r.t + slotS),
      color: `--lamp-${OUTCOMES[r.outcome]?.color ?? 'neutral'}`,
      id: r.id,
      label: `run #${r.id} · ${outcomeLabel(r.outcome)}`,
    }
  })
  if (nextRun !== null) blocks.push({ from: nextRun, to: nextRun + slotS, color: '--lamp-green', id: null, label: 'next run', outline: true })
  return blocks
}

/** The block at `t`, the latest one starting at or before it. */
export function blockAt(blocks: RunBlock[], t: number): RunBlock | null {
  let found: RunBlock | null = null
  for (const b of blocks) if (b.from <= t && t < b.to) found = b
  return found
}
