// Where the flags above a chart go (one per market session): at their session's start, kept inside the plot, never
// on top of each other, in two rows. Sessions of one direction whose flags would touch share one flag ("↓ BUY 15.5 kW
// +1"). Where two flags still would, the left one steps down to a shorter text (the one under the pointer keeps its
// longest); with no shorter text left, the right one goes to the second row, and is left out only where that row has
// no room either.

export interface FlagItem {
  id: string
  /** The session's start, px. */
  at: number
  /** The widths of its texts, px, longest first ("↓ SELL 5.2–9.4 kW", then "↓"). */
  widths: number[]
  /** Under the pointer: keeps its longest text. */
  hovered?: boolean
}

export interface PlacedFlag {
  id: string
  left: number
  width: number
  /** Which of its texts. */
  text: number
  /** The first row (0) or the second (1). */
  row: 0 | 1
}

/** Back-to-back sessions of one group (direction) as runs under one flag: a session joins the run before it while it
 *  starts within that run's flag (`width` of a run, px) and `gap`. Each run keeps the order of `items` by `at`. */
export function groupFlags<T extends { at: number; group: string }>(
  items: T[],
  width: (run: T[]) => number,
  gap = 4,
): T[][] {
  const runs: T[][] = []
  for (const item of [...items].sort((a, b) => a.at - b.at)) {
    const run = runs[runs.length - 1]
    const first = run?.[0]
    if (run && first && first.group === item.group && item.at < first.at + width(run) + gap) run.push(item)
    else runs.push([item])
  }
  return runs
}

export function layoutFlags(items: FlagItem[], min: number, max: number, gap = 4): PlacedFlag[] {
  const first = layoutRow(items, min, max, gap)
  const placed = new Set(first.map((f) => f.id))
  const rest = items.filter((i) => !placed.has(i.id))
  const second = rest.length > 0 ? layoutRow(rest, min, max, gap) : []
  return [...first.map((f) => ({ ...f, row: 0 as const })), ...second.map((f) => ({ ...f, row: 1 as const }))]
}

/** One row of flags; the ones that don't fit are left out. */
function layoutRow(items: FlagItem[], min: number, max: number, gap: number): Omit<PlacedFlag, 'row'>[] {
  const sorted = [...items].sort((a, b) => a.at - b.at)
  // each item's text, the longest that fits the plot to begin with; past its last text it is left out
  const choice = new Map(sorted.map((i) => [i.id, i.widths.findIndex((w) => w <= max - min)]))
  for (let round = 0; round <= 2 * items.length * 3; round++) {
    const placed = sorted.flatMap((item) => {
      const text = choice.get(item.id) ?? -1
      const width = item.widths[text]
      if (text < 0 || width === undefined) return []
      return [{ item, id: item.id, text, width, left: Math.min(Math.max(item.at, min), max - width) }]
    })
    const k = placed.findIndex((p, i) => {
      const next = placed[i + 1]
      return next !== undefined && p.left + p.width + gap > next.left
    })
    const a = placed[k]
    const b = placed[k + 1]
    if (!a || !b) return placed.map(({ id, left, width, text }) => ({ id, left, width, text }))
    // a shorter text only makes room on the left flag, or on the right one while the plot's edge pushes it left
    const helps = (p: typeof a) => p === a || p.left < Math.max(p.item.at, min)
    const shorter = [a, b]
      .filter((p) => helps(p) && !p.item.hovered && p.text + 1 < p.item.widths.length)
      .sort((x, y) => y.width - x.width)[0]
    if (shorter) choice.set(shorter.id, shorter.text + 1)
    else choice.set((b.item.hovered ? a : b).id, -1)
  }
  return []
}
