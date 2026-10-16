// What the Plan page's chart heads add up for the window shown: energy over the quarter-hours in it, and where the
// state of charge is now and where the plan takes it.

/** The energy (kWh) of the power `values` (W, one per slot start in `x`, each holding to the next) over `window`:
 *  only what is above zero with `sign` 1 (the grid's import), below with −1 (its export, as a positive number), or all
 *  of it with 0. Slots the window cuts count for the part inside it. */
export function energyIn(
  x: number[],
  values: (number | null)[],
  window: [number, number],
  sign: 1 | -1 | 0,
): number {
  let wh = 0
  for (let i = 0; i + 1 < x.length; i++) {
    const v = values[i]
    if (v === null || v === undefined || !Number.isFinite(v)) continue
    const a = Math.max(x[i]!, window[0])
    const b = Math.min(x[i + 1]!, window[1])
    if (b <= a) continue
    const w = sign === 1 ? Math.max(0, v) : sign === -1 ? Math.max(0, -v) : v
    wh += (w * (b - a)) / 3600
  }
  return wh / 1000
}

/** The state of charge at `nowS` (the last value at or before it) and at the plan's end (the last value), in the
 *  series' unit; null where there is none. */
export function socSummary(x: number[], soc: (number | null)[], nowS: number): { now: number | null; end: number | null } {
  let now: number | null = null
  let end: number | null = null
  for (let i = 0; i < x.length; i++) {
    const v = soc[i]
    if (v === null || v === undefined || !Number.isFinite(v)) continue
    if (x[i]! <= nowS) now = v
    end = v
  }
  return { now, end }
}

/** "12.4 kWh" (one decimal; whole kWh from 100). */
export function formatKwh(kwh: number): string {
  return `${Math.abs(kwh) >= 100 ? kwh.toFixed(0) : kwh.toFixed(1)} kWh`
}
