// "Today, slot by slot" on the controller pages: each decision of a day as a mark on a 00–24 axis, coloured by
// whether the Home Assistant automation did the same, with the rule (branch, action) named where it changes.

export type StripState = 'same' | 'differs' | 'none'

export interface StripInput {
  /** When the decision applies (unix seconds): the slot start, or the moment it was made. */
  t: number
  /** The compare run's outcome, if the decision was compared: ok = same, mismatch = differs. */
  compare?: string | null
  /** The rule, branch or action, named above the strip where it changes. */
  label?: string | null
  /** The run a click on the mark opens. */
  runId?: number | null
  /** How long this decision held, in seconds; the strip's default span otherwise. */
  span?: number
}

export interface StripItem {
  /** Position from the start of the day, 0–1. */
  x: number
  /** Width as a share of the day. */
  w: number
  state: StripState
  label: string | null
  runId: number | null
}

export interface StripLabel {
  x: number
  text: string
}

/** Marks for the decisions that fall in [dayStart, dayEnd), each `span` seconds wide (a slot, or a short tick). */
export function stripItems(inputs: StripInput[], dayStart: number, dayEnd: number, span: number): StripItem[] {
  const day = dayEnd - dayStart
  if (!(day > 0)) return []
  return inputs
    .filter((i) => i.t >= dayStart && i.t < dayEnd)
    .sort((a, b) => a.t - b.t)
    .map((i) => ({
      x: (i.t - dayStart) / day,
      w: Math.min(i.span ?? span, dayEnd - i.t) / day,
      state: i.compare === 'ok' ? 'same' : i.compare === 'mismatch' ? 'differs' : 'none',
      label: i.label ?? null,
      runId: i.runId ?? null,
    }))
}

/** For decisions made at irregular moments (the charger, the market): each holds until the next one, at most `max`
 *  seconds and at least `min`. */
export function holdUntilNext(inputs: StripInput[], max: number, min = 60): StripInput[] {
  const sorted = [...inputs].sort((a, b) => a.t - b.t)
  return sorted.map((input, i) => {
    const next = sorted[i + 1]
    return { ...input, span: Math.max(min, Math.min(max, next ? next.t - input.t : max)) }
  })
}

/** The label of each item whose rule differs from the one before, dropping any closer than `minGap` (share of the
 *  day) to the last one kept, so the names don't overlap. */
export function stripLabels(items: StripItem[], minGap = 0.08): StripLabel[] {
  const out: StripLabel[] = []
  let previous: string | null = null
  for (const item of items) {
    if (!item.label || item.label === previous) continue
    previous = item.label
    const last = out[out.length - 1]
    if (last && item.x - last.x < minGap) continue
    out.push({ x: item.x, text: item.label })
  }
  return out
}

/** How many of the day's compared decisions were the same as the automation. */
export function stripCounts(items: StripItem[]): { same: number; differs: number; none: number } {
  const counts = { same: 0, differs: 0, none: 0 }
  for (const item of items) counts[item.state]++
  return counts
}
