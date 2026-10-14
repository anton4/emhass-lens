// Where the flags above a chart go (one per market session): at their session's start, kept inside the plot, never
// on top of each other. Where two would touch, the wider one steps down to a shorter text (the one under the pointer
// keeps its longest); one with no shorter text left is left out.

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
}

export function layoutFlags(items: FlagItem[], min: number, max: number, gap = 4): PlacedFlag[] {
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
    const shorter = [a, b]
      .filter((p) => !p.item.hovered && p.text + 1 < p.item.widths.length)
      .sort((x, y) => y.width - x.width)[0]
    if (shorter) choice.set(shorter.id, shorter.text + 1)
    else choice.set((b.item.hovered ? a : b).id, -1)
  }
  return []
}
