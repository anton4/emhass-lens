// Columns on a time chart (the price breakdown): one per slot, a gap between neighbours, a hairline between the parts
// stacked in one, and the slot under the pointer.

/** The gap between two columns in CSS px, by how wide a slot is: wide enough to see, gone when columns get thin. */
export function columnGap(slotPx: number): number {
  if (slotPx >= 8) return 2
  if (slotPx >= 3) return 1
  if (slotPx >= 2) return 0.5
  return 0
}

/** What one stacked part covers in a column, from `lo` (the part below it, or zero) to `hi`, and which end steps back
 *  a hairline from its neighbour: the low end when the part sits on another, the zero end of a part below zero. */
export function columnSegment(lo: number, hi: number): { from: number; to: number; inset: 'low' | 'high' | null } | null {
  const from = Math.min(lo, hi)
  const to = Math.max(lo, hi)
  if (to - from <= 0) return null
  if (from >= 0) return { from, to, inset: from > 0 ? 'low' : null }
  if (to <= 0) return { from, to, inset: 'high' }
  return { from, to, inset: null }
}

/** The slot `value` falls in: the last start at or before it, never the closing point after the last slot. */
export function slotIndex(starts: ArrayLike<number>, value: number): number {
  const last = starts.length - 2
  if (last < 0) return 0
  let lo = 0
  let hi = last
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((starts[mid] ?? Infinity) <= value) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Whether the slot [start, end) lies inside one of `ranges` (a forecast). */
export function inRanges(start: number, end: number, ranges: readonly [number, number][]): boolean {
  return ranges.some(([a, b]) => start >= a && end <= b)
}
