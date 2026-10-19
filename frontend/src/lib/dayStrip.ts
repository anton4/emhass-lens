import { spanLabel } from './chartTime'
import { shiftDay, zonedTime } from './days'

// "Today, slot by slot" on the controller pages: each decision of a day as a mark on the day's axis, coloured by
// whether the Home Assistant automation did the same (or by what the page passes as the fill), with the rule (branch,
// action, state) named inside each stretch it holds, and an Automation row of the stretches it agreed and differed.

export type StripState = 'same' | 'differs' | 'none'

export interface StripInput<D = unknown> {
  /** When the decision applies (unix seconds): the slot start, or the moment it was made. */
  t: number
  /** The compare run's outcome, if the decision was compared: ok = same, mismatch = differs. */
  compare?: string | null
  /** The rule, branch or action, named inside the stretch of marks that share it. */
  label?: string | null
  /** The run a click on the mark opens. */
  runId?: number | null
  /** How long this decision held, in seconds; the strip's default span otherwise. */
  span?: number
  /** CSS background of the mark (a colour or a texture); without it the mark shows the comparison. */
  fill?: string | null
  /** CSS colour of the name on that fill (at least 4.5:1); none for a texture, whose name sits on a chip. */
  ink?: string | null
  /** EMHASS Lens wrote to the device for this decision (live). */
  wrote?: boolean
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
  ink: string | null
  wrote: boolean
  detail?: D
}

/** A moment marked over the strip's marks (e.g. a button press). */
export interface StripTick {
  /** Unix seconds. */
  t: number
  /** CSS colour of the mark. */
  color: string
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
      ink: i.ink ?? null,
      wrote: i.wrote ?? false,
      detail: i.detail,
    }))
}

/** A run of consecutive decisions with the same name: what the strip's popup shows. */
export interface Stretch {
  /** The first decision (unix seconds). */
  from: number
  /** The last decision (unix seconds). */
  last: number
  /** What was decided: the first input's detail, else its label. */
  title: string | null
  decisions: number
  same: number
  differs: number
  /** The mark's fill, for the popup's swatch. */
  fill?: string | null
}

// a quarter-hour tick that starts a second late still continues the stretch
const STRETCH_SLACK = 60

/** For decisions made at irregular moments (the charger, the market): consecutive decisions with the same label make
 *  one mark, which holds until the next mark, at most `max` seconds after its last decision and at least `min` in all.
 *  A label change, a missing label or a gap of more than `max` starts a new mark. A mark differs if any of its
 *  decisions did, and opens the first that differed (else its first). Each input's detail is the popup's title. A
 *  mark takes its first decision's fill and ink, and wrote if any of its decisions did. */
export function holdStretches(inputs: StripInput<string>[], max: number, min = 60): StripInput<Stretch>[] {
  const sorted = [...inputs].sort((a, b) => a.t - b.t)
  const groups: StripInput<string>[][] = []
  for (const input of sorted) {
    const group = groups.at(-1)
    const previous = group?.at(-1)
    if (group && previous?.label && previous.label === input.label && input.t - previous.t <= max + STRETCH_SLACK) {
      group.push(input)
    } else {
      groups.push([input])
    }
  }
  return groups.map((group, i) => {
    const first = group[0]!
    const last = group.at(-1)!
    const next = groups[i + 1]?.[0]
    const until = Math.min(last.t + max, next?.t ?? Infinity)
    const differing = group.find((g) => g.compare === 'mismatch')
    const same = group.filter((g) => g.compare === 'ok').length
    const differs = group.filter((g) => g.compare === 'mismatch').length
    const fill = first.fill ?? null
    return {
      t: first.t,
      span: Math.max(min, until - first.t),
      compare: differs > 0 ? 'mismatch' : same > 0 ? 'ok' : null,
      label: first.label ?? null,
      runId: (differing ?? first).runId ?? null,
      fill,
      ink: first.ink ?? null,
      wrote: group.some((g) => g.wrote),
      detail: {
        from: first.t,
        last: last.t,
        title: first.detail ?? first.label ?? null,
        decisions: group.length,
        same,
        differs,
        fill,
      },
    }
  })
}

/** What a decision looks like on a strip the page fills: its name there, its key entry, fill and the name's ink on
 *  it, and whether it wrote (live). */
export interface StripMark {
  label: string | null
  key: string
  fill: string
  ink: string | null
  wrote: boolean
}

/** The strip's key from each decision's mark: one entry per key seen, in `order` (others after, as first seen), with
 *  its fill and how many decisions. */
export function keyCounts(
  marks: (Pick<StripMark, 'key' | 'fill'> | null | undefined)[],
  order: readonly string[] = [],
): { text: string; fill: string; count: number }[] {
  const seen = new Map<string, { text: string; fill: string; count: number }>()
  for (const mark of marks) {
    if (!mark) continue
    const entry = seen.get(mark.key)
    if (entry) entry.count++
    else seen.set(mark.key, { text: mark.key, fill: mark.fill, count: 1 })
  }
  const rank = (key: string) => (order.includes(key) ? order.indexOf(key) : order.length)
  return [...seen.values()].sort((x, y) => rank(x.text) - rank(y.text))
}

/** How many of a stretch's decisions the automation agreed and differed on, for the Automation row. */
export function stretchTally(item: Pick<StripItem<Stretch>, 'detail'>): { same: number; differs: number } {
  return { same: item.detail?.same ?? 0, differs: item.detail?.differs ?? 0 }
}

/** Where a stretch of several decisions differed, for the Automation row's popup; null for a single decision. */
export function stretchDiffers(item: Pick<StripItem<Stretch>, 'detail'>): string | null {
  const s = item.detail
  return s && s.decisions > 1 ? `${s.differs} of ${s.decisions} decisions differed` : null
}

/** How a stretch compared with the automation, in words. */
export function stretchText(s: Stretch): string {
  const none = s.decisions - s.same - s.differs
  if (s.decisions === 1) {
    return s.differs
      ? 'The automation did something else.'
      : s.same
        ? 'The automation did the same.'
        : 'Not compared with the automation.'
  }
  const parts = [
    s.same > 0 && `${s.same} the same as the automation`,
    s.differs > 0 && `${s.differs} different`,
    none > 0 && `${none} not compared`,
  ].filter(Boolean)
  return `${s.decisions} decisions: ${parts.join(', ')}.`
}

/** A stretch of touching marks with the same name and fill: where its name goes inside the strip. */
export interface StripSegment {
  x: number
  w: number
  /** The name, longest first: the strip shows the first that fits. */
  names: string[]
  ink: string | null
  /** The first and the last item of the stretch. */
  from: number
  to: number
}

const touches = (a: StripItem, b: StripItem) => Math.abs(a.x + a.w - b.x) < 1e-6

/** The stretches of touching items with the same label and fill, in order; items without a label have no name. */
export function stripSegments(items: StripItem[]): StripSegment[] {
  const out: StripSegment[] = []
  items.forEach((item, i) => {
    if (!item.label) return
    const last = out.at(-1)
    const previous = items[i - 1]
    const joins = previous?.label === item.label && previous.fill === item.fill && touches(previous, item)
    if (last && last.to === i - 1 && joins) {
      last.w = item.x + item.w - last.x
      last.to = i
    } else {
      out.push({ x: item.x, w: item.w, names: [item.label], ink: item.ink, from: i, to: i })
    }
  })
  return out
}

// A name inside the strip is 12 px Geist at weight 600 (about 7 px a character) with 8 px padding each side; on a
// chip (a textured fill) the chip's own padding comes on top.
const CHAR_PX = 7
const PAD_PX = 16
const CHIP_PX = 12

/** Whether `text` fits inside a stretch `px` wide. */
export function labelFits(text: string, px: number, chip = false): boolean {
  return text.length * CHAR_PX + PAD_PX + (chip ? CHIP_PX : 0) <= px
}

/** The first of a stretch's names (longest first) that fits in `px`, else null. */
export function segmentText(names: string[], px: number, chip = false): string | null {
  return names.find((n) => labelFits(n, px, chip)) ?? null
}

/** An hour on the day's axis. */
export interface DayHour {
  /** Unix seconds. */
  t: number
  /** "03:00"; the day's end is "24:00". */
  label: string
  /** The local hour, 0–24. */
  hour: number
}

const hourFormats = new Map<string, Intl.DateTimeFormat>()

/** Every hour from local midnight of `day` to the next: 25 marks, 26 on the day the clocks go back (an hour twice)
 *  and 24 on the day they go forward (an hour left out). */
export function dayHours(day: string, timeZone?: string): DayHour[] {
  const start = zonedTime(day, 0, 0, timeZone).getTime() / 1000
  const end = zonedTime(shiftDay(day, 1), 0, 0, timeZone).getTime() / 1000
  const key = timeZone ?? ''
  let fmt = hourFormats.get(key)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false })
    hourFormats.set(key, fmt)
  }
  const out: DayHour[] = []
  for (let t = start; t < end; t += 3600) {
    const label = fmt.format(new Date(t * 1000))
    out.push({ t, label, hour: Number(label.slice(0, 2)) })
  }
  out.push({ t: end, label: '24:00', hour: 24 })
  return out
}

/** How the Automation row draws and names its two outcomes. */
export const AGREE_TONES = {
  same: { fill: 'var(--line-green)', ink: 'var(--on-green)', text: 'agreed', title: 'Automation agreed' },
  differs: { fill: 'var(--line-amber)', ink: 'var(--on-amber)', text: 'differed', title: 'Automation differed' },
} as const

/** A stretch of the Automation row: consecutive compared marks with the same outcome. */
export interface AgreeRun {
  state: 'same' | 'differs'
  /** Where it starts and how wide it is, as shares of the day. */
  x: number
  w: number
  /** The marks it covers (indices into the strip's items). */
  items: number[]
  /** How many decisions in it were the same as the automation, and how many differed. */
  same: number
  differs: number
}

/** The Automation row: runs of consecutive compared marks that all agreed with the automation (or all differed),
 *  bridging the time between them; a mark that wasn't compared ends a run. `tally` counts a mark's decisions (a
 *  stretch can hold several); one per mark by default. */
export function agreeRuns<D>(
  items: StripItem<D>[],
  tally: (item: StripItem<D>) => { same: number; differs: number } = (i) => ({
    same: i.state === 'same' ? 1 : 0,
    differs: i.state === 'differs' ? 1 : 0,
  }),
): AgreeRun[] {
  const out: AgreeRun[] = []
  let joins = false // the last run is still open: no mark without a comparison came since
  for (const [i, item] of items.entries()) {
    if (item.state === 'none') {
      joins = false
      continue
    }
    const t = tally(item)
    const last = out.at(-1)
    if (joins && last?.state === item.state) {
      last.w = item.x + item.w - last.x
      last.items.push(i)
      last.same += t.same
      last.differs += t.differs
    } else {
      out.push({ state: item.state, x: item.x, w: item.w, items: [i], same: t.same, differs: t.differs })
    }
    joins = true
  }
  return out
}

/** What an Automation run says, counting `what`s (slots or decisions). */
export function agreeText(run: Pick<AgreeRun, 'state' | 'same' | 'differs'>, what: string): string {
  const total = run.same + run.differs
  const n = (k: number) => `${k} ${what}${k === 1 ? '' : 's'}`
  if (run.state === 'same') {
    return total <= 1 ? 'The automation did the same.' : `The automation did the same in all ${n(total)}.`
  }
  if (total <= 1) return 'The automation did something else.'
  return run.differs === total
    ? `The automation did something else in all ${n(total)}.`
    : `The automation did something else in ${run.differs} of ${n(total)}.`
}

const clockFormats = new Map<string, Intl.DateTimeFormat>()

/** "05:00–05:15 · 15 min" for unix seconds [a, b); an end at the next midnight reads 24:00. */
export function formatSpan(a: number, b: number, timeZone?: string): string {
  const key = timeZone ?? ''
  let fmt = clockFormats.get(key)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false })
    clockFormats.set(key, fmt)
  }
  const from = fmt.format(new Date(a * 1000))
  const to = fmt.format(new Date(b * 1000))
  return `${from}–${to === '00:00' && b > a ? '24:00' : to} · ${spanLabel(b - a)}`
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
  const joins = (a: StripItem | undefined, b: StripItem | undefined) => !!a && !!b && key(a) === key(b) && touches(a, b)
  return items.map((item, i) => ({ start: !joins(items[i - 1], item), end: !joins(item, items[i + 1]) }))
}

/** How many of the day's compared decisions were the same as the automation. */
export function stripCounts(items: StripItem[]): { same: number; differs: number; none: number } {
  const counts = { same: 0, differs: 0, none: 0 }
  for (const item of items) counts[item.state]++
  return counts
}
