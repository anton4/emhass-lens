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
