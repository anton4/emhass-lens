// The Timeline's table view: the quarter-hours around the cursor (or now), measured left of now and the plan right of
// it, with the prices.

import { slotIndex } from './chartColumns'

export interface AroundRow {
  /** The slot's start, unix s. */
  t: number
  grid: number | null
  pv: number | null
  house: number | null
  /** + charging. */
  battery: number | null
  /** %. */
  soc: number | null
  import: number | null
  export: number | null
  /** The slot the cursor (or now) is in. */
  current: boolean
  measured: boolean
}

/** `n` quarter-hours of grid `x` around the one `at` is in (half before it), with each column's value there; the
 *  battery in + charge. `prices` by slot start. */
export function tableAround(
  at: number,
  x: number[],
  cols: {
    grid: (number | null)[] | null
    pv: (number | null)[] | null
    load: (number | null)[] | null
    /** EMHASS's sign: + discharge. */
    battery: (number | null)[] | null
    soc: (number | null)[] | null
  },
  prices: Map<number, { import: number | null; export: number | null }>,
  nowS: number,
  n = 24,
): AroundRow[] {
  // the closing point of x isn't a slot
  const slots = x.length - 1
  if (slots <= 0) return []
  const i = Math.min(Math.max(slotIndex(x, at), 0), slots - 1)
  const start = Math.max(0, Math.min(i - Math.floor(n / 2), slots - n))
  const out: AroundRow[] = []
  for (let k = start; k < Math.min(slots, start + n); k++) {
    const t = x[k]!
    const v = (a: (number | null)[] | null) => a?.[k] ?? null
    const batt = v(cols.battery)
    const price = prices.get(t)
    out.push({
      t,
      grid: v(cols.grid),
      pv: v(cols.pv),
      house: v(cols.load),
      battery: batt === null ? null : -batt,
      soc: v(cols.soc),
      import: price?.import ?? null,
      export: price?.export ?? null,
      current: k === i,
      measured: t + 900 <= nowS,
    })
  }
  return out
}
