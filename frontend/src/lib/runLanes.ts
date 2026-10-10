// Jobs grouped into the lanes of the Runs timeline, in a fixed order.

export const LANES = ['EMHASS', 'Prices', 'Inverter', 'EV charger', 'Market', 'ML', 'Measurements', 'System'] as const

export type Lane = (typeof LANES)[number]

const PREFIXES: [string, Lane][] = [
  ['emhass.', 'EMHASS'],
  ['nordpool.', 'Prices'],
  ['forecast.', 'Prices'],
  ['inverter.', 'Inverter'],
  ['charger.', 'EV charger'],
  ['market.', 'Market'],
  ['external.', 'Market'],
  ['ml.', 'ML'],
  ['measure.', 'Measurements'],
]

/** The lane a job's runs are drawn in; everything not listed (health, storage, parity, …) is System. */
export function laneOf(job: string): Lane {
  return PREFIXES.find(([prefix]) => job.startsWith(prefix))?.[1] ?? 'System'
}

const STEPS = [60, 120, 300, 600, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 24 * 3600]

/** Moments for the time axis: on round minutes or hours, about `count` of them across the window. */
export function axisTicks(from: number, to: number, count = 6): number[] {
  if (!(to > from)) return []
  const span = to - from
  const step = STEPS.find((s) => s >= span / count) ?? Math.ceil(span / count / 86400) * 86400
  const first = Math.ceil(from / step) * step
  const out: number[] = []
  for (let t = first; t <= to; t += step) out.push(t)
  return out
}

/** The timeline windows and the bucket each is cut into: about 60–100 bars across. */
export const TIMELINE_WINDOWS = {
  '1h': { label: '1 h', hours: 1, bucketS: 60 },
  '6h': { label: '6 h', hours: 6, bucketS: 300 },
  '24h': { label: '24 h', hours: 24, bucketS: 900 },
} as const

export type TimelineWindow = keyof typeof TIMELINE_WINDOWS

export function isTimelineWindow(value: string | null): value is TimelineWindow {
  return value !== null && value in TIMELINE_WINDOWS
}

/** The window ending at the next bucket boundary after `nowS`, in unix seconds. */
export function timelineBounds(window: TimelineWindow, nowS: number): { from: number; to: number; count: number } {
  const { hours, bucketS } = TIMELINE_WINDOWS[window]
  const to = Math.ceil(nowS / bucketS) * bucketS
  return { from: to - hours * 3600, to, count: (hours * 3600) / bucketS }
}

/** Outcome colours, most notable first: a bucket is coloured by the worst thing in it. */
export type CellColor = 'red' | 'amber' | 'blue' | 'green' | 'neutral'
const RANK: Record<CellColor, number> = { red: 4, amber: 3, blue: 2, green: 1, neutral: 0 }

export interface TimelineCell {
  bucket: number
  color: CellColor
  /** Outcomes in the bucket with their counts, most notable first. */
  counts: { outcome: string; count: number }[]
  /** The run a click opens: the newest one of the most notable colour. */
  runId: number
}

export interface TimelineLane {
  lane: Lane
  /** One entry per bucket; null where nothing ran. */
  cells: (TimelineCell | null)[]
}

/** Server cells (job, bucket, outcome, count, newest id) as lanes of bars, plus run totals per colour. */
export function timelineCells(
  cells: { job: string; bucket: number; outcome: string; count: number; last_id: number }[],
  count: number,
  colorOf: (outcome: string) => CellColor,
): { lanes: TimelineLane[]; totals: Record<CellColor, number> } {
  const totals: Record<CellColor, number> = { red: 0, amber: 0, blue: 0, green: 0, neutral: 0 }
  const byLane = new Map<Lane, Map<number, { outcome: string; count: number; lastId: number }[]>>()
  for (const cell of cells) {
    if (cell.bucket < 0 || cell.bucket >= count) continue
    totals[colorOf(cell.outcome)] += cell.count
    const lane = laneOf(cell.job)
    const buckets = byLane.get(lane) ?? new Map<number, { outcome: string; count: number; lastId: number }[]>()
    const list = buckets.get(cell.bucket) ?? []
    const same = list.find((o) => o.outcome === cell.outcome)
    if (same) {
      same.count += cell.count
      same.lastId = Math.max(same.lastId, cell.last_id)
    } else list.push({ outcome: cell.outcome, count: cell.count, lastId: cell.last_id })
    buckets.set(cell.bucket, list)
    byLane.set(lane, buckets)
  }
  const lanes: TimelineLane[] = []
  for (const lane of LANES) {
    const buckets = byLane.get(lane)
    if (!buckets) continue
    const row: (TimelineCell | null)[] = Array.from({ length: count }, () => null)
    for (const [bucket, outcomes] of buckets) {
      outcomes.sort((a, b) => RANK[colorOf(b.outcome)] - RANK[colorOf(a.outcome)] || b.count - a.count)
      const color = colorOf(outcomes[0]!.outcome)
      const runId = Math.max(...outcomes.filter((o) => colorOf(o.outcome) === color).map((o) => o.lastId))
      row[bucket] = { bucket, color, counts: outcomes.map(({ outcome, count: n }) => ({ outcome, count: n })), runId }
    }
    lanes.push({ lane, cells: row })
  }
  return { lanes, totals }
}
