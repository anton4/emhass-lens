// Time on the charts' axis: local midnights, how long a span is, a range and the cursor's moment as text, and whether a
// label sits clear of the now line.

const hourFormats = new Map<string, Intl.DateTimeFormat>()
function hourMinute(timeZone: string): Intl.DateTimeFormat {
  let fmt = hourFormats.get(timeZone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false })
    hourFormats.set(timeZone, fmt)
  }
  return fmt
}

/** Local midnights in (a, b], unix s; quarter-hours, so a day of 23 or 25 hours has its own. */
export function localMidnights(a: number, b: number, timeZone: string): number[] {
  const fmt = hourMinute(timeZone)
  const out: number[] = []
  for (let t = Math.floor(a / 900) * 900 + 900; t <= b; t += 900) {
    if (fmt.format(new Date(t * 1000)) === '00:00') out.push(t)
  }
  return out
}

/** How long `seconds` is: "40 s", "45 min", "3 h", "3 h 45 min", "2.6 days". */
export function spanLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} s`
  const minutes = Math.round(s / 60)
  if (minutes < 60) return `${minutes} min`
  if (s >= 2 * 86400) return `${(s / 86400).toFixed(1)} days`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

const rangeFormats = new Map<string, { clock: Intl.DateTimeFormat; day: Intl.DateTimeFormat; date: Intl.DateTimeFormat }>()
function formats(timeZone: string) {
  let fmt = rangeFormats.get(timeZone)
  if (!fmt) {
    const clock = { timeZone, hour: '2-digit', minute: '2-digit', hour12: false } as const
    fmt = {
      clock: new Intl.DateTimeFormat('en-GB', clock),
      day: new Intl.DateTimeFormat('en-GB', { ...clock, weekday: 'short' }),
      date: new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }),
    }
    rangeFormats.set(timeZone, fmt)
  }
  return fmt
}

/** A range of time: "12:45 – 16:30" within one day, "Thu 15:30 → Sun 05:00" across days. */
export function rangeLabel(a: number, b: number, timeZone: string): string {
  const fmt = formats(timeZone)
  const da = new Date(a * 1000)
  const db = new Date(b * 1000)
  if (fmt.date.format(da) === fmt.date.format(db)) return `${fmt.clock.format(da)} – ${fmt.clock.format(db)}`
  return `${fmt.day.format(da)} → ${fmt.day.format(db)}`
}

const secondFormats = new Map<string, Intl.DateTimeFormat>()
/** The cursor's moment on the time axis: "13:25:20" with `seconds` (a 10-second reading), else "13:25". */
export function cursorTimeLabel(t: number, timeZone: string, seconds: boolean): string {
  if (!seconds) return formats(timeZone).clock.format(new Date(t * 1000))
  let fmt = secondFormats.get(timeZone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    secondFormats.set(timeZone, fmt)
  }
  return fmt.format(new Date(Math.floor(t) * 1000))
}

/** Is `px` at least `gap` px away from every position in `avoid`? */
export function clearOf(px: number, avoid: (number | null | undefined)[], gap: number): boolean {
  return avoid.every((a) => a === null || a === undefined || !Number.isFinite(a) || Math.abs(px - a) >= gap)
}
