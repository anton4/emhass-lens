// "Today, slot by slot" on the controller pages: each decision of a day as a mark on a 00–24 axis, coloured by
// whether the Home Assistant automation did the same (or by what the page passes as the fill), with the rule (branch,
// action, state) named where it changes.

export type StripState = 'same' | 'differs' | 'none'

export interface StripInput<D = unknown> {
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
  /** CSS background of the mark (a colour or a texture); without it the mark shows the comparison. */
  fill?: string | null
  /** CSS colour of the line under the mark; no line without it. */
  band?: string | null
  /** The everyday label: it gives way to the others when names would overlap. */
  quiet?: boolean
  /** What the mark's popup shows. */
  detail?: D
}

export interface StripItem<D = unknown> {
  /** Position from the start of the day, 0–1. */
  x: number
  /** Width as a share of the day. */
  w: number
  state: StripState
  label: string | null
  runId: number | null
  fill: string | null
  band: string | null
  quiet: boolean
  detail?: D
}

export interface StripLabel {
  x: number
  text: string
  /** The name hangs to the left of its mark (it would run past the end of the day). */
  end: boolean
}

/** Marks for the decisions that fall in [dayStart, dayEnd), each `span` seconds wide (a slot, or a short tick). */
export function stripItems<D>(inputs: StripInput<D>[], dayStart: number, dayEnd: number, span: number): StripItem<D>[] {
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
      fill: i.fill ?? null,
      band: i.band ?? null,
      quiet: i.quiet ?? false,
      detail: i.detail,
    }))
}

/** For decisions made at irregular moments (the charger, the market): each holds until the next one, at most `max`
 *  seconds and at least `min`. */
export function holdUntilNext<D>(inputs: StripInput<D>[], max: number, min = 60): StripInput<D>[] {
  const sorted = [...inputs].sort((a, b) => a.t - b.t)
  return sorted.map((input, i) => {
    const next = sorted[i + 1]
    return { ...input, span: Math.max(min, Math.min(max, next ? next.t - input.t : max)) }
  })
}

// The names are 11 px monospace (about 6.6 px a character) after a 4 px tick padding.
const CHAR_PX = 6.6
const PAD_PX = 10
const GAP_PX = 6

/** The label of each item whose label differs from the one before, on a strip `width` px wide. A name that would
 *  overlap one already placed is left out; quiet names are placed last, so they give way to the others. */
export function stripLabels(items: StripItem[], width = 1000): StripLabel[] {
  const candidates: { x: number; text: string; quiet: boolean }[] = []
  let previous: string | null = null
  for (const item of items) {
    if (!item.label || item.label === previous) continue
    previous = item.label
    candidates.push({ x: item.x, text: item.label, quiet: item.quiet })
  }
  const gap = GAP_PX / width
  const placed: { from: number; to: number; label: StripLabel }[] = []
  for (const c of [...candidates.filter((c) => !c.quiet), ...candidates.filter((c) => c.quiet)]) {
    const w = (c.text.length * CHAR_PX + PAD_PX) / width
    const end = c.x + w > 1
    const from = end ? c.x - w : c.x
    const to = end ? c.x : c.x + w
    if (placed.some((p) => from < p.to + gap && p.from < to + gap)) continue
    placed.push({ from, to, label: { x: c.x, text: c.text, end } })
  }
  return placed.map((p) => p.label).sort((a, b) => a.x - b.x)
}

export interface StripRun {
  /** The first mark of a run of equal marks (same fill, or same comparison without a fill). */
  start: boolean
  /** The last mark of its run. */
  end: boolean
}

/** Where each run of equal, touching marks starts and ends, so the strip can round and separate them. */
export function stripRuns(items: StripItem[]): StripRun[] {
  const key = (i: StripItem) => i.fill ?? i.state
  const joins = (a: StripItem | undefined, b: StripItem | undefined) =>
    !!a && !!b && key(a) === key(b) && Math.abs(a.x + a.w - b.x) < 1e-6
  return items.map((item, i) => ({ start: !joins(items[i - 1], item), end: !joins(item, items[i + 1]) }))
}

/** How many of the day's compared decisions were the same as the automation. */
export function stripCounts(items: StripItem[]): { same: number; differs: number; none: number } {
  const counts = { same: 0, differs: 0, none: 0 }
  for (const item of items) counts[item.state]++
  return counts
}
