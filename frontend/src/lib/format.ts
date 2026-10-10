// Formatting helpers. Timestamps from the API are ISO 8601 UTC; they are shown in the browser's
// local time (Home Assistant users are in the same timezone as their installation), or in an explicit
// timezone (e.g. the bidding zone's, from the API) when one is passed.

type FormatKind = 'time' | 'dateTime' | 'day' | 'slot' | 'slotDay' | 'dayKey'

const OPTIONS: Record<FormatKind, Intl.DateTimeFormatOptions> = {
  time: { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false },
  dateTime: { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false },
  day: { month: 'short', day: 'numeric' },
  slot: { hour: '2-digit', minute: '2-digit', hour12: false },
  slotDay: { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false },
  dayKey: { year: 'numeric', month: '2-digit', day: '2-digit' },
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function fmt(kind: FormatKind, timeZone?: string): Intl.DateTimeFormat {
  const key = `${kind}|${timeZone ?? ''}`
  let f = formatters.get(key)
  if (!f) {
    // en-CA gives the sortable "2026-10-09" for day keys; display formats use the browser's locale
    f = new Intl.DateTimeFormat(kind === 'dayKey' ? 'en-CA' : undefined, { ...OPTIONS[kind], timeZone })
    formatters.set(key, f)
  }
  return f
}

export function parseTime(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Calendar day of a moment in `timeZone` (browser time if omitted), e.g. "2026-10-09". */
export function dayKey(d: Date, timeZone?: string): string {
  return fmt('dayKey', timeZone).format(d)
}

function sameDay(a: Date, b: Date, timeZone?: string): boolean {
  return dayKey(a, timeZone) === dayKey(b, timeZone)
}

/** "14:13:00" today, "Oct 8, 14:13:00" otherwise. */
export function formatTime(iso: string | null | undefined, now: Date = new Date(), timeZone?: string): string {
  const d = parseTime(iso)
  if (!d) return '—'
  return sameDay(d, now, timeZone) ? fmt('time', timeZone).format(d) : fmt('dateTime', timeZone).format(d)
}

/** Always "14:13:00". */
export function formatClock(iso: string | null | undefined, timeZone?: string): string {
  const d = parseTime(iso)
  return d ? fmt('time', timeZone).format(d) : '—'
}

export function formatDay(iso: string | null | undefined, timeZone?: string): string {
  const d = parseTime(iso)
  return d ? fmt('day', timeZone).format(d) : '—'
}

/** Milliseconds as "820 ms", "4.2 s", "2 min 05 s", "1 h 03 min". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`
  const totalS = Math.round(s)
  const minutes = Math.floor(totalS / 60)
  const seconds = totalS % 60
  if (minutes < 60) return `${minutes} min ${String(seconds).padStart(2, '0')} s`
  const hours = Math.floor(minutes / 60)
  return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`
}

/** Time until `iso`: "in 4:32", "in 1 h 05 min", "now", or "3 min ago" for the past. */
export function formatCountdown(iso: string | null | undefined, now: Date = new Date()): string {
  const d = parseTime(iso)
  if (!d) return '—'
  const diffS = Math.round((d.getTime() - now.getTime()) / 1000)
  if (Math.abs(diffS) < 1) return 'now'
  const abs = Math.abs(diffS)
  let text: string
  if (abs < 3600) {
    const m = Math.floor(abs / 60)
    const s = abs % 60
    text = `${m}:${String(s).padStart(2, '0')}`
  } else if (abs < 86400) {
    const h = Math.floor(abs / 3600)
    const m = Math.floor((abs % 3600) / 60)
    text = `${h} h ${String(m).padStart(2, '0')} min`
  } else {
    const days = Math.floor(abs / 86400)
    const h = Math.floor((abs % 86400) / 3600)
    text = `${days} d ${h} h`
  }
  return diffS > 0 ? `in ${text}` : `${text} ago`
}

/** Seconds into a quarter-hour as the clock positions it fires at: 780 -> ":13:00, :28:00, :43:00, :58:00". */
export function formatQuarterOffset(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—'
  const s = ((Math.floor(seconds) % 900) + 900) % 900
  const minutes = Math.floor(s / 60)
  const secs = s % 60
  return [0, 1, 2, 3]
    .map((i) => `:${String((minutes + 15 * i) % 60).padStart(2, '0')}:${String(secs).padStart(2, '0')}`)
    .join(', ')
}

/** Bytes as "512 B", "14.2 KiB", "3.1 MiB", "1.2 GiB". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

/** Display value for diffs and previews. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'empty'
  if (typeof value === 'string') return value === '' ? '""' : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/** A quarter-hour slot start: "17:45" today, "Sat 17:45" on other days (24-hour). */
export function formatSlot(iso: string | null | undefined, now: Date = new Date(), timeZone?: string): string {
  const d = parseTime(iso)
  if (!d) return '—'
  return sameDay(d, now, timeZone) ? fmt('slot', timeZone).format(d) : fmt('slotDay', timeZone).format(d)
}
