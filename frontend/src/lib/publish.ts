// The plan values of one slot as EMHASS signs them, in words people use.

/** P_batt > 0 discharges the battery, < 0 charges it (EMHASS convention). */
export function batteryText(watts: number | null | undefined): string {
  if (watts === null || watts === undefined || Number.isNaN(watts)) return '—'
  if (Math.abs(watts) < 50) return 'idle'
  return `${watts > 0 ? 'discharges' : 'charges'} ${(Math.abs(watts) / 1000).toFixed(1)} kW`
}

/** P_grid > 0 imports from the grid, < 0 exports. */
export function gridText(watts: number | null | undefined): string {
  if (watts === null || watts === undefined || Number.isNaN(watts)) return '—'
  if (Math.abs(watts) < 50) return '≈ 0'
  return `${watts > 0 ? 'imports' : 'exports'} ${(Math.abs(watts) / 1000).toFixed(1)} kW`
}

export function kwText(watts: number | null | undefined): string {
  if (watts === null || watts === undefined || Number.isNaN(watts)) return '—'
  return `${(watts / 1000).toFixed(1)} kW`
}

/** True when `iso` falls inside the quarter-hour slot that contains `now`. */
export function inCurrentSlot(iso: string | null | undefined, now: Date): boolean {
  if (!iso) return false
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return false
  const slotStart = Math.floor(now.getTime() / 900_000) * 900_000
  return t >= slotStart && t < slotStart + 900_000
}
