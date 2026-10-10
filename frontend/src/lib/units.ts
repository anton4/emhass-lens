// Units and value formatting for energy data.

export type PriceUnit = 'eur' | 'cents'

const kw = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const w = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })

export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Power in W as "850 W" or "12.34 kW"; null/undefined as "—". */
export function formatPower(watts: unknown): string {
  if (!isNumber(watts)) return '—'
  if (Math.abs(watts) < 1000) return `${w.format(Math.round(watts))} W`
  return `${kw.format(watts / 1000)} kW`
}

/** €/kWh as "0.1234 €/kWh" or "12.34 c/kWh". */
export function formatPrice(eurPerKwh: unknown, unit: PriceUnit = 'eur', withUnit = true): string {
  if (!isNumber(eurPerKwh)) return '—'
  const text = unit === 'cents' ? (eurPerKwh * 100).toFixed(2) : eurPerKwh.toFixed(4)
  return withUnit ? `${text} ${unit === 'cents' ? 'c/kWh' : '€/kWh'}` : text
}

/** A price axis tick in €/kWh: "0.05", "0.1", "0.125" (no trailing zeros, at most 3 decimals). */
export function eurTick(value: number): string {
  return `${Number(value.toFixed(3))} €`
}

export function priceFactor(unit: PriceUnit): number {
  return unit === 'cents' ? 100 : 1
}

/** A 0–1 fraction as "62.0 %". */
export function formatFraction(value: unknown, digits = 1): string {
  if (!isNumber(value)) return '—'
  return `${(value * 100).toFixed(digits)} %`
}

/** Seconds as "34 s", "5 min", "2 h 10 min" (ages of sensor values). */
export function formatAge(seconds: number | null | undefined): string {
  if (!isNumber(seconds)) return '—'
  if (seconds < 90) return `${Math.round(seconds)} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`
}

/** Battery power with its direction: EMHASS P_batt > 0 discharges, < 0 charges. */
export function batteryDirection(watts: unknown): string {
  if (!isNumber(watts) || Math.abs(watts) < 1) return 'Idle'
  return watts > 0 ? 'Discharging' : 'Charging'
}

/** Grid power with its direction: EMHASS P_grid > 0 imports, < 0 exports. */
export function gridDirection(watts: unknown): string {
  if (!isNumber(watts) || Math.abs(watts) < 1) return 'No flow'
  return watts > 0 ? 'Importing' : 'Exporting'
}
