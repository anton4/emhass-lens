// Qilowatt market control (experimental): shapes of the backend's free-form market data, and helpers to show
// decisions, comparisons, sessions and the write throttle. See backend/emhass_lens/domain/market.py.

import type { LampColor } from '../components/Lamp'
import type { ChartGap, ChartLane, ChartOverlay, ChartSession } from '../components/charts/TimeChart'
import type { PopupBlock, PopupExtra } from '../components/charts/cursorStore'
import type { GridDetail, MarketCommandSpan, MarketSettings, MarketWatchdogStatus, RunSummary } from '../api/types'
import { formatClock, formatTime } from './format'
import { gridAt } from './gridDetail'
import { formatPower, formatSignedPower } from './units'
import type { CompareField } from './inverter'
import type { InverterTargets } from './inverter'
import { marketFill, NO_SETTINGS_FILL, NO_SETTINGS_INK, NOT_IN_CONTROL_FILL } from './inverter'
import type { StripInput, StripMark, WriteTick } from './dayStrip'

export interface MarketThrottle {
  grid_delta_w: number
  effective_deadband_w: number
  rails_wrong: boolean
  since_commit_s: number | null
  cooldown_bypass: boolean
  bypass_reasons: string[]
  cooldown_block: boolean
  reasons: string[]
  gap_for_s?: number | null // how long the grid target has been more than deadband_w off (since 0.4.39)
  gap_held?: boolean // the gap outlasted the cooldown, so deadband_w applied instead of the proportional deadband
}

export interface MarketDecision {
  action: string // buy | sell | end | none
  end_reason: string
  cmd_dir: string
  continuing: boolean
  is_initial_sell: boolean
  power_gate_w: number
  qw_power_w: number
  source_ok: boolean
  source_lost: boolean
  bad_powerlimit: boolean
  anomaly: boolean
  session_after: string | null
  enable_boolean_after: string | null
  targets: InverterTargets | null
  feedin_w: number | null
  feedin_write: boolean
  feedin_why: string
  needs_update: boolean
  throttle: MarketThrottle
  message: string
  notify: string | null
  why: string
  notes?: string[]
  parity_feedin_w?: number | null // what the automation would set the feed-in limit to (since 0.4.25)
  parity_feedin_write?: boolean
  parity_needs_update?: boolean // whether the automation would write the registers now (since 0.4.39)
}

/** status.last and the `market_decision` artifact (which also carries `inputs`). */
export interface MarketLast {
  at: string
  trigger: string
  decision: MarketDecision
  session_before: string | null
  run_id: number | null
  blocked: string | null
  inputs?: Record<string, unknown>
}

/** status.last_compare and the `market_comparison` artifact. */
export interface MarketComparison {
  at?: string
  agree: boolean
  fields: CompareField[]
  decision_run_id?: number
  expected?: Record<string, unknown>
}

export interface MarketSensors {
  source: string | null
  mode: string | null
  powerlimit_w: number | null
  soc_pct: number | null
  pv_w: number | null
  load_w?: number | null
  ha_session: string | null
  enable_boolean: string | null
  settle_pending: boolean
}

export function marketModeSpec(mode: string | null | undefined): { color: LampColor; text: string; explain: string } {
  switch (mode) {
    case 'live':
      return {
        color: 'red',
        text: 'Live: runs the sessions',
        explain: 'EMHASS Lens runs the Kratt/Fusebox sessions itself. The Home Assistant automation must be off.',
      }
    case 'shadow':
      return {
        color: 'blue',
        text: 'Shadow',
        explain:
          'Decides like the automation on every command change and every minute, and compares with what it did. Never writes.',
      }
    default:
      return { color: 'neutral', text: 'Off', explain: 'Market control is off. Nothing is decided or compared.' }
  }
}

export interface ParsedSummary {
  kind: 'command' | 'end' | 'none' | 'blocked' | 'ignored' | 'other'
  text: string
}

/** The gist of a reconcile run's summary: "Would: Kratt sell 5000W: set …", "Kratt sell 7000W: registers unchanged
 * (held: cooldown)", "Qilowatt safeguard: session ended (mode_cleared) …", "No action: …", "Not in control …". */
export function parseReconcileSummary(summary: string | null | undefined): ParsedSummary | null {
  if (!summary) return null
  const s = summary.replace(/^Would: /, '')
  if (s.startsWith('Qilowatt safeguard: session ended')) {
    const reason = /session ended \(([a-z_]+)\)/.exec(s)?.[1] ?? 'end'
    return { kind: 'end', text: `session ended (${reason.replace('_', ' ')})` }
  }
  if (s.startsWith('Qilowatt safeguard: ignored')) return { kind: 'ignored', text: s.replace('Qilowatt safeguard: ', '') }
  if (summary.startsWith('Not in control')) return { kind: 'blocked', text: summary }
  if (summary.startsWith('No action')) return { kind: 'none', text: summary.replace(/^No action: /, '') }
  const command = /^([A-Z][a-z]+ (?:buy|sell) \d+W)/.exec(s)
  if (command) return { kind: 'command', text: command[1]! }
  return { kind: 'other', text: summary }
}

/** A reconcile decision on the Market page's day strip: named by its command ("Kratt sell 7000W") or what it did, a
 *  session striped in the colour of the passive state it sets (as on the Inverter strip; a striped or hatched mark's
 *  name gets a chip), and
 *  whether it wrote to the inverter (live: it set the passive registers or the feed-in limit). Null for runs without a
 *  summary. */
export function marketMark(summary: string | null | undefined): StripMark | null {
  const parsed = parseReconcileSummary(summary)
  if (!parsed || !summary) return null
  const mark = (label: string | null, key: string, fill: string, ink: string | null) => ({
    label,
    key,
    fill,
    ink,
    wrote: false,
  })
  switch (parsed.kind) {
    case 'command': {
      const direction = /\b(buy|sell)\b/.exec(parsed.text)?.[1] ?? 'sell'
      const wrote = !summary.startsWith('Would: ') && /: (set '|feed-in )/.test(summary)
      return { ...mark(parsed.text, `Market ${direction}`, marketFill(direction), null), wrote }
    }
    case 'none':
      return mark('no action', 'No action', NO_SETTINGS_FILL, NO_SETTINGS_INK)
    case 'end':
      return mark('session end', 'Session end', 'var(--ink-faint)', 'var(--surface)')
    case 'blocked':
      return mark('not in control', 'Not in control', NOT_IN_CONTROL_FILL, null)
    case 'ignored':
      return mark('ignored', 'Ignored', 'var(--lamp-amber)', 'var(--on-lamp-amber)')
    default:
      return mark(null, 'Other', NO_SETTINGS_FILL, NO_SETTINGS_INK)
  }
}

/** The decision id a compare run's summary refers to ("Decision #12: …"). */
export function decisionRef(summary: string | null | undefined): number | null {
  const match = /Decision #(\d+)/.exec(summary ?? '')
  return match ? Number(match[1]) : null
}

export interface MarketRow {
  reconcile?: RunSummary
  compare?: RunSummary
  at: string
}

/** Reconcile runs with the compare run that judged them, newest first. */
export function pairMarketCompares(reconciles: RunSummary[], compares: RunSummary[]): MarketRow[] {
  const rows = new Map<number, MarketRow>()
  for (const r of reconciles) rows.set(r.id, { reconcile: r, at: r.started_at })
  const loose: MarketRow[] = []
  for (const c of compares) {
    const ref = decisionRef(c.summary)
    const row = ref === null ? undefined : rows.get(ref)
    if (row && !row.compare) row.compare = c
    else loose.push({ compare: c, at: c.started_at })
  }
  return [...rows.values(), ...loose].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

export const MARKET_FIELD_LABELS: Record<string, string> = {
  session: 'Session select',
  enable_boolean: 'EMHASS automation switch',
  state: 'Passive state',
  grid_power_w: 'Grid power',
  battery_max_w: 'Battery max',
  battery_min_w: 'Battery min',
  feedin_max_w: 'Feed-in max',
}

export function marketFieldValue(_field: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value
  return `${Math.round(value)} W`
}

/** The three wear guards in words, with the configured thresholds. */
export function marketGuards(thresholds: MarketSettings['thresholds'] | undefined): { title: string; text: string }[] {
  const t = thresholds ?? {
    enter_w: 1000,
    exit_w: 400,
    cooldown_s: 180,
    big_change_w: 2500,
    deadband_w: 300,
    deadband_pct: 0.15,
    min_soc: 10,
    sell_full_soc_pct: 97,
    settle_s: 2,
    unavailable_timeout_s: 300,
    low_pv_w: 100,
    buy_cap_w: 18200,
    sell_cap_w: 15500,
    buy_modes: ['buy', 'mfrrdown', 'frrdown'],
    sell_modes: ['sell', 'mfrrup', 'frrup'],
    sources: ['fusebox', 'kratt'],
  }
  return [
    {
      title: 'Direction-aware hysteresis',
      text: `A session starts, or flips direction, only for a command of at least ${t.enter_w} W; it continues in the same direction down to ${t.exit_w} W. A command under its gate while a session is open ends the session (it never flips it).`,
    },
    {
      title: 'Proportional deadband',
      text: `The grid target is rewritten only when it moves by more than max(${t.deadband_w} W, ${Math.round(t.deadband_pct * 100)} % of the target); a gap of more than ${t.deadband_w} W that holds for ${t.cooldown_s} s is written anyway.`,
    },
    {
      title: 'Cooldown',
      text: `At most one write per ${t.cooldown_s} s, except for a session start or end, a direction change, wrong battery rails, or a change of at least ${t.big_change_w} W. A session end is never throttled.`,
    },
    {
      title: 'Feed-in limit only when it matters',
      text: `While selling, the inverter exports the lower of the grid target and the feed-in limit. A limit at or above the command is left as it is, and a lower one is raised to ${t.sell_cap_w} W at once. The limit follows the command only when the battery can't take the spare PV: at ${t.sell_full_soc_pct} % or more, with the PV beyond the house above the command plus the deadband.`,
    },
    {
      title: 'Also',
      text: `No selling below ${t.min_soc} % battery; a lost source ends the session after ${t.unavailable_timeout_s} s; commands settle for ${t.settle_s} s before they are read; buy targets cap at ${t.buy_cap_w} W (Fusebox always gets the cap) and sell targets at ${t.sell_cap_w} W; sources ${(t.sources ?? []).join(', ')}; buy commands ${(t.buy_modes ?? []).join(', ')}; sell commands ${(t.sell_modes ?? []).join(', ')}.`,
    },
  ]
}

/** What the automation would do with the feed-in limit where EMHASS Lens decided otherwise (sells only). */
export function parityFeedinText(d: MarketDecision): string | null {
  if (d.action !== 'sell' || d.parity_feedin_w === undefined || d.parity_feedin_w === null) return null
  if (d.parity_feedin_write === d.feedin_write && (!d.feedin_write || d.parity_feedin_w === d.feedin_w)) return null
  return d.parity_feedin_write
    ? `The automation would write ${d.parity_feedin_w} W.`
    : `The automation would leave it for now (its target: ${d.parity_feedin_w} W).`
}

export function sessionText(session: { direction: string; power_w: number | null; source: string | null } | null | undefined): string {
  if (!session) return 'none'
  return `${session.direction} ${session.power_w ?? '?'} W (${session.source ?? '?'})`
}

const WATCHDOG_KINDS: Record<string, string> = {
  stale: 'Session stuck',
  long_session: 'Long session',
  emhass_off: 'EMHASS left off',
}

function duration(seconds: number): string {
  return seconds % 3600 === 0 ? `${seconds / 3600} h` : `${Math.round(seconds / 60)} min`
}

/** The session watchdog in one fact: off, what it finds now, or what it watches for. */
export function watchdogText(
  w: MarketWatchdogStatus | null | undefined,
  now: Date = new Date(),
  tz?: string,
): { color: LampColor; text: string; detail: string | null } {
  if (!w || !w.enabled) return { color: 'neutral', text: 'Off', detail: 'Turned off under Settings → Qilowatt market control.' }
  if (w.mode === 'off') return { color: 'neutral', text: 'Off', detail: 'Watches while market control is on.' }
  const finding = w.findings.find((f) => f.severity === 'error') ?? w.findings[0]
  if (finding) {
    const message = finding.message.charAt(0).toUpperCase() + finding.message.slice(1)
    return { color: finding.severity === 'error' ? 'red' : 'amber', text: WATCHDOG_KINDS[finding.kind] ?? finding.kind, detail: message }
  }
  const last = w.checked_at ? `last check ${formatTime(w.checked_at, now, tz)} · ` : ''
  const clears = w.mode === 'live' ? `clears a session after ${duration(w.stale_after_s)} without a source` : 'records only'
  const acted = w.last_action
    ? ` · last: ${String(w.last_action.summary ?? '')} (${formatTime(String(w.last_action.at ?? ''), now, tz)})`
    : ''
  return { color: 'green', text: 'Every minute', detail: `${last}${clears}, warns after ${duration(w.long_session_s)}${acted}` }
}

// --- Qilowatt's commands on the Plan page's Power chart -----

const unix = (iso: string) => Date.parse(iso) / 1000

const kw1 = (w: number) => (w / 1000).toFixed(1)

// a sell regulates up (the grid takes power), a buy down
const SELL_ARROW = '↑'
const BUY_ARROW = '↓'
const head = (sell: boolean) => (sell ? `${SELL_ARROW} SELL` : `${BUY_ARROW} BUY`)

/** A span's end; one still on when it was read runs on to `nowS`. */
const spanEnd = (s: MarketCommandSpan, nowS?: number) =>
  s.open && nowS !== undefined ? Math.max(unix(s.end), nowS) : unix(s.end)

/** A command's power the way the chart's grid counts it: a buy imports (+), a sell exports (−). */
export function commandPower(span: Pick<MarketCommandSpan, 'direction' | 'power_w'>): number {
  return span.direction === 'buy' ? span.power_w : -span.power_w
}

/** The grid's mean just before the command's session (W, + import), 0 when there is none. */
export function baselineOf(span: Pick<MarketCommandSpan, 'baseline_w'>): number {
  return span.baseline_w ?? 0
}

/** Where the command asks the grid to be: its session's baseline less a sell's power, plus a buy's. */
export function commandTarget(span: Pick<MarketCommandSpan, 'direction' | 'power_w' | 'baseline_w'>): number {
  return baselineOf(span) + commandPower(span)
}

/** The commanded power as an ink line over the Power chart, stepping at the commands' own times. The measured grid
 *  line's buckets break at those times too, so the two lines step together. The y-axis fits the measured lines, not
 *  the commands: one past it runs along the edge with its direction and power ("↓ 15.5 kW"). */
export function marketOverlay(spans: MarketCommandSpan[], nowS?: number): ChartOverlay {
  return {
    label: 'Commanded',
    color: '--q-market',
    width: 1.5,
    dash: [6, 4],
    base: 'none',
    fit: false,
    dot: true,
    offScale: (value) => `${value > 0 ? BUY_ARROW : SELL_ARROW} ${kw1(Math.abs(value))} kW`,
    spans: spans.map((s) => ({ from: unix(s.start), to: spanEnd(s, nowS), value: commandTarget(s) })),
  }
}

/** What the grid delivered in the command's direction, from its session's baseline: the measured mean less the
 *  baseline for a buy, the baseline less it for a sell (so a sell's export counts positive like its power); null when
 *  it wasn't measured. */
export function deliveredW(span: Pick<MarketCommandSpan, 'direction' | 'measured_w' | 'baseline_w'>): number | null {
  const w = span.measured_w
  if (w === null || w === undefined) return null
  const base = baselineOf(span)
  return span.direction === 'buy' ? w - base : base - w
}

/** Back-to-back commands in one direction: a session as the Power chart shows it. */
export interface CommandSession {
  /** Its first command's start. */
  id: string
  direction: string
  from: number
  /** An open one runs on to now. */
  to: number
  open: boolean
  spans: MarketCommandSpan[]
  minW: number
  maxW: number
  /** The share of the energy asked that the grid delivered, over the commands it was measured for; null if none. */
  delivered: number | null
}

/** The commands grouped into sessions: a new one where the direction changes or a gap of a second or more opens. */
export function commandSessions(spans: MarketCommandSpan[], nowS?: number): CommandSession[] {
  const sessions: CommandSession[] = []
  for (const span of [...spans].sort((a, b) => unix(a.start) - unix(b.start))) {
    const from = unix(span.start)
    const to = spanEnd(span, nowS)
    const last = sessions[sessions.length - 1]
    if (last && last.direction === span.direction && Math.abs(from - last.to) < 1) {
      last.spans.push(span)
      last.to = Math.max(last.to, to)
      last.open ||= span.open
      continue
    }
    sessions.push({ id: span.start, direction: span.direction, from, to, open: span.open, spans: [span], minW: 0, maxW: 0, delivered: null })
  }
  for (const s of sessions) {
    const powers = s.spans.map((x) => x.power_w)
    s.minW = Math.min(...powers)
    s.maxW = Math.max(...powers)
    let asked = 0
    let got = 0
    for (const x of s.spans) {
      const w = deliveredW(x)
      if (w === null) continue
      const seconds = spanEnd(x, nowS) - unix(x.start)
      asked += x.power_w * seconds
      got += Math.min(Math.max(w, 0), x.power_w) * seconds
    }
    s.delivered = asked > 0 ? got / asked : null
  }
  return sessions
}

// A command falls short where the grid delivers less than it by more than max(500 W, 10 % of it) for a minute or
// more; a ramp of a few seconds after each change doesn't count.
const SHORT_MIN_W = 500
const SHORT_SHARE = 0.1
const SHORT_MIN_S = 60

export interface Shortfall {
  from: number
  to: number
  /** The most that was missing, W. */
  worstW: number
  /** The detail's buckets in it, with the commanded and the measured power (EMHASS's sign): the gap to hatch. */
  pieces: { from: number; to: number; commanded: number; measured: number }[]
}

/** Where the measured grid power fell short of a command, from the grid detail. Its buckets break where a command
 *  changes, so each bucket is under one command; a stretch the detail had no value for is never short. */
export function shortfalls(spans: MarketCommandSpan[], detail: GridDetail | undefined, nowS?: number): Shortfall[] {
  if (!detail || detail.points.length === 0 || spans.length === 0) return []
  const end = unix(detail.end)
  const commands = spans.map((s) => ({
    from: unix(s.start),
    to: spanEnd(s, nowS),
    sign: s.direction === 'buy' ? 1 : -1,
    w: s.power_w,
    base: baselineOf(s),
  }))
  const pieces: (Shortfall['pieces'][number] & { missing: number })[] = []
  detail.points.forEach((p, i) => {
    if (p.w === null) return
    const next = detail.points[i + 1]
    const a = unix(p.t)
    const b = next ? unix(next.t) : end
    for (const c of commands) {
      const from = Math.max(a, c.from)
      const to = Math.min(b, c.to)
      if (to <= from) continue
      // what the grid delivered from the baseline, in the command's direction
      const missing = c.w - c.sign * (p.w - c.base)
      if (missing > Math.max(SHORT_MIN_W, SHORT_SHARE * c.w)) {
        pieces.push({ from, to, commanded: c.base + c.sign * c.w, measured: p.w, missing })
      }
    }
  })
  pieces.sort((x, y) => x.from - y.from)
  const runs: Shortfall[] = []
  for (const { missing, ...piece } of pieces) {
    const last = runs[runs.length - 1]
    if (last && Math.abs(piece.from - last.to) < 1) {
      last.to = Math.max(last.to, piece.to)
      last.worstW = Math.max(last.worstW, missing)
      last.pieces.push(piece)
    } else {
      runs.push({ from: piece.from, to: piece.to, worstW: missing, pieces: [piece] })
    }
  }
  return runs.filter((r) => r.to - r.from >= SHORT_MIN_S)
}

/** The hatched gaps between the commanded and the measured line. */
export function shortfallGap(runs: Shortfall[]): ChartGap {
  return {
    color: '--q-shortfall',
    spans: runs.flatMap((r) => r.pieces.map((p) => ({ from: p.from, to: p.to, a: p.commanded, b: p.measured }))),
  }
}

/** "5.2–9.4 kW", or "12.0 kW" for one power. */
function powerRange(s: CommandSession): string {
  return s.minW === s.maxW ? `${kw1(s.maxW)} kW` : `${kw1(s.minW)}–${kw1(s.maxW)} kW`
}

const hhmm = (t: number, timeZone?: string) => formatClock(new Date(t * 1000).toISOString(), timeZone).slice(0, 5)

/** "08:45–09:32", "08:45–now". */
function sessionTimes(s: CommandSession, timeZone?: string): string {
  return `${hhmm(s.from, timeZone)}–${s.open ? 'now' : hhmm(s.to, timeZone)}`
}

function sessionSources(s: CommandSession): string {
  const unique = (xs: string[]) => [...new Set(xs)].join(', ')
  return `${unique(s.spans.map((x) => x.source))} · ${unique(s.spans.map((x) => x.mode))}`
}

const deliveredText = (s: CommandSession) => (s.delivered === null ? null : `${Math.round(s.delivered * 100)} % delivered`)

/** The balancing product a Qilowatt mode names: "mfrrup" mFRR, "frrup" (or "afrr…") aFRR, or null for a plain
 *  "buy"/"sell". (The owner's reading of the modes, 2026-10-16.) */
export function marketProduct(mode: string): 'mFRR' | 'aFRR' | null {
  const m = mode.toLowerCase()
  if (m.startsWith('mfrr')) return 'mFRR'
  if (m.startsWith('afrr') || m.startsWith('frr')) return 'aFRR'
  return null
}

/** The product all of a session's commands share, or null. */
export function sessionProduct(s: Pick<CommandSession, 'spans'>): 'mFRR' | 'aFRR' | null {
  const products = new Set(s.spans.map((x) => marketProduct(x.mode)))
  return products.size === 1 ? ([...products][0] ?? null) : null
}

/** "↑ SELL · mFRR", or "↑ SELL" without a product. */
const sessionHead = (sell: boolean, product: string | null) => (product ? `${head(sell)} · ${product}` : head(sell))

/** The sessions as bands across the Power chart, each with a flag: "↑ SELL 5.2–9.4 kW", and while the pointer is in
 *  it "↑ SELL · kratt · mfrrup · 08:45–09:32 · 95 % delivered". Sessions of one direction share a flag where theirs
 *  would touch. */
export function sessionBands(sessions: CommandSession[], timeZone?: string): ChartSession[] {
  return sessions.map((s) => {
    const sell = s.direction === 'sell'
    const delivered = deliveredText(s)
    const product = sessionProduct(s)
    return {
      id: s.id,
      from: s.from,
      to: s.to,
      group: s.direction,
      color: sell ? '--q-sell' : '--q-buy',
      ink: sell ? '--q-sell-ink' : '--q-buy-ink',
      label: product ? `${sessionHead(sell, product)} · ${powerRange(s)}` : `${head(sell)} ${powerRange(s)}`,
      detail: [head(sell), sessionSources(s), sessionTimes(s, timeZone), delivered].filter(Boolean).join(' · '),
      short: sell ? SELL_ARROW : BUY_ARROW,
      hatch: product === 'aFRR',
    }
  })
}

/** "shortfall 3 min" over the session's shortfalls, or null without any. */
function shortfallText(runs: Shortfall[]): string | null {
  const seconds = runs.reduce((sum, r) => sum + r.to - r.from, 0)
  return seconds > 0 ? `shortfall ${Math.max(1, Math.round(seconds / 60))} min` : null
}

/** The sessions as a lane under the chart: one bar each with its delivered share ("95 %", or "sell · 24 commands ·
 *  95 % delivered · shortfall 3 min" where it fits), its shortfalls hatched across it as on the chart. */
export function marketLane(sessions: CommandSession[], runs: Shortfall[] = []): ChartLane {
  return {
    label: 'Market',
    spans: sessions.map((s) => {
      const sell = s.direction === 'sell'
      const delivered = deliveredText(s)
      const commands = `${s.spans.length} ${s.spans.length === 1 ? 'command' : 'commands'}`
      const short = runs.filter((r) => r.to > s.from && r.from < s.to)
      return {
        from: s.from,
        to: s.to,
        color: sell ? '--q-sell' : '--q-buy',
        ink: sell ? '--q-sell-ink' : '--q-buy-ink',
        text: s.delivered === null ? undefined : `${Math.round(s.delivered * 100)} %`,
        long: [s.direction, sessionProduct(s), commands, delivered, shortfallText(short)].filter(Boolean).join(' · '),
        marks: short.map((r) => ({ from: r.from, to: r.to, color: '--q-shortfall' })),
        id: s.id,
      }
    }),
  }
}

/** The zoom window for a session: its time with a few minutes either side, in whole quarter-hours. */
export function sessionWindow(s: Pick<CommandSession, 'from' | 'to'>, slotS = 900): [number, number] {
  const margin = Math.max(120, (s.to - s.from) * 0.1)
  return [Math.floor((s.from - margin) / slotS) * slotS, Math.ceil((s.to + margin) / slotS) * slotS]
}

/** The popup's block for the command at `time`: the command and since when, the measured grid there and its share of
 *  the command (or, without the detail, what the grid delivered over the command), a shortfall, and the session. */
export function marketBlock(o: {
  spans: MarketCommandSpan[]
  sessions: CommandSession[]
  runs: Shortfall[]
  detail: GridDetail | undefined
  time: number
  nowS?: number
  timeZone?: string
}): PopupBlock | null {
  const span = spanAt(o.spans, o.time, o.nowS)
  if (!span) return null
  const sell = span.direction === 'sell'
  const delivery = sessionDelivery(span, o.detail, o.time)
  const rows: PopupBlock['rows'] = []
  if (delivery?.moment && o.runs.some((r) => r.from <= o.time && o.time < r.to)) {
    rows.push({
      name: 'Shortfall',
      value: formatPower(span.power_w - delivery.got),
      color: '--q-shortfall',
      swatch: 'hatch',
      alert: true,
    })
  }
  const session = o.sessions.find((s) => s.from <= o.time && o.time < s.to)
  const foot = session
    ? [
        `Session ${sessionTimes(session, o.timeZone)} · ${session.spans.length} ${session.spans.length === 1 ? 'command' : 'commands'}`,
        [powerRange(session), deliveredText(session)].filter(Boolean).join(' · '),
      ]
    : undefined
  const kw = (w: number) => (w / 1000).toFixed(2)
  const text = delivery
    ? `${kw(delivery.got)} of ${kw(span.power_w)} kW delivered (${Math.round(delivery.share * 100)} %${
        delivery.moment ? '' : span.open ? ', so far' : ', mean over the command'
      })`
    : `${kw(span.power_w)} kW requested`
  return {
    title: sessionHead(sell, marketProduct(span.mode)),
    sub: `${span.source} · ${span.mode}`,
    tone: sell ? 'sell' : 'buy',
    text,
    meter: delivery ? Math.min(1, Math.max(0, delivery.share)) : undefined,
    rows,
    foot,
  }
}

/** The command at `time`, or none. */
function spanAt(spans: MarketCommandSpan[], time: number, nowS?: number): MarketCommandSpan | undefined {
  return spans.find((s) => unix(s.start) <= time && time < spanEnd(s, nowS))
}

/** What the grid delivered of the command `span` in its own direction: at the pointer's moment where there is a
 *  reading (`moment`), else the mean over the command; with its share of the power asked. Null when nothing was
 *  measured. */
export function sessionDelivery(
  span: MarketCommandSpan,
  detail: GridDetail | undefined,
  time: number,
): { got: number; share: number; moment: boolean } | null {
  const w = gridAt(detail, time)
  const base = baselineOf(span)
  const got = w !== null ? (span.direction === 'sell' ? base - w : w - base) : deliveredW(span)
  if (got === null) return null
  return { got, share: span.power_w > 0 ? got / span.power_w : 0, moment: w !== null }
}

/** The popup's rows right under the grid's reading during a command: where it put the grid (the baseline less a
 *  sell's power, plus a buy's), since when, and the baseline. */
export function marketLead(o: { spans: MarketCommandSpan[]; time: number; nowS?: number; timeZone?: string }): PopupExtra[] {
  const span = spanAt(o.spans, o.time, o.nowS)
  if (!span) return []
  const rows: PopupExtra[] = [
    {
      name: `${span.baseline_w !== null && span.baseline_w !== undefined ? 'commanded target' : 'commanded'}, since ${formatClock(span.start, o.timeZone)}`,
      value: formatSignedPower(commandTarget(span)),
      color: '--q-market',
      swatch: 'dash',
    },
  ]
  if (span.baseline_w !== null && span.baseline_w !== undefined) {
    rows.push({ name: 'baseline, before the session', value: formatSignedPower(span.baseline_w), color: '--ink-faint', swatch: 'none' })
  }
  return rows
}

/** A stretch of the Market strip: one Qilowatt session, or the time between them; with how the reconcile decisions in
 *  it compared with the automation. */
export interface SessionStretch {
  from: number
  to: number
  session: CommandSession | null
  decisions: number
  same: number
  differs: number
}

/** The Market strip's stretches for [dayStart, dayEnd) up to `nowS`: each of Qilowatt's sessions (striped in the state
 *  it sets, named "↑ SELL · mFRR · 9.4–11.0 kW" where it fits) and "idle" between them, each compared through the
 *  reconcile decisions in it (`rows`); a click opens the session's first decision. */
export function sessionInputs(
  spans: MarketCommandSpan[],
  rows: MarketRow[],
  dayStart: number,
  dayEnd: number,
  nowS: number,
): StripInput<SessionStretch>[] {
  const end = Math.min(dayEnd, nowS)
  if (!(end > dayStart)) return []
  const sessions = commandSessions(spans, nowS).filter((s) => s.to > dayStart && s.from < end)
  const decided = rows
    .map((r) => ({ t: unix(r.at), outcome: r.compare?.outcome ?? null, runId: r.reconcile?.id ?? null }))
    .sort((a, b) => a.t - b.t)
  const stretch = (from: number, to: number, session: CommandSession | null): StripInput<SessionStretch> => {
    const inside = decided.filter((d) => d.t >= from && d.t < to)
    const same = inside.filter((d) => d.outcome === 'ok').length
    const differs = inside.filter((d) => d.outcome === 'mismatch').length
    const detail = { from, to, session, decisions: inside.length, same, differs }
    const base = { t: from, span: to - from, compare: differs > 0 ? 'mismatch' : same > 0 ? 'ok' : null, detail }
    if (!session) return { ...base, label: 'idle', fill: NO_SETTINGS_FILL, ink: NO_SETTINGS_INK }
    const sell = session.direction === 'sell'
    const product = sessionProduct(session)
    return {
      ...base,
      label: product ? `${head(sell)} · ${product}` : head(sell),
      fill: marketFill(session.direction),
      ink: null,
      amount: session.maxW,
      runId: inside.find((d) => d.runId !== null)?.runId ?? null,
    }
  }
  const out: StripInput<SessionStretch>[] = []
  let cursor = dayStart
  for (const s of sessions) {
    // a session that starts before the last one ended (only ever in made-up data) starts where it ended
    const from = Math.max(s.from, dayStart, cursor)
    const to = Math.min(s.to, end)
    if (to <= from) continue
    if (from > cursor) out.push(stretch(cursor, from, null))
    out.push(stretch(from, to, s))
    cursor = to
  }
  if (end > cursor) out.push(stretch(cursor, end, null))
  return out
}

/** The rows of a session's popup: what was asked, what the grid delivered of it from its baseline, the baseline, and
 *  the commands. */
export function sessionRows(s: CommandSession, nowS?: number): { k: string; v: string }[] {
  const requested = s.minW === s.maxW ? `${kw2(s.maxW)} kW` : `${kw2(s.minW)}–${kw2(s.maxW)} kW`
  let asked = 0
  let got = 0
  let seconds = 0
  for (const x of s.spans) {
    const w = deliveredW(x)
    if (w === null) continue
    const t = spanEnd(x, nowS) - unix(x.start)
    asked += x.power_w * t
    got += w * t
    seconds += t
  }
  const delivered =
    seconds > 0 ? `${kw2(got / seconds)} kW (${Math.round((got / asked) * 100)} %)` : 'not measured'
  const base = s.spans[0]?.baseline_w
  const rows = [
    { k: 'Requested', v: requested },
    { k: 'Delivered', v: delivered },
    { k: 'Baseline', v: base === null || base === undefined ? 'not known' : formatSignedPower(base) },
    { k: 'Commands', v: String(s.spans.length) },
  ]
  return rows
}

const kw2 = (w: number) => (w / 1000).toFixed(2)

/** A session in words: "↑ SELL · mFRR · kratt". */
export function sessionName(s: CommandSession): string {
  return [head(s.direction === 'sell'), sessionProduct(s), s.spans[0]?.source].filter(Boolean).join(' · ')
}

/** The Market strip's "Lens wrote" row from the reconcile decisions: each write (live), each write shadow would have
 *  made, and each one held by the deadband or the cooldown (since 0.5.3; "(no write: cooldown)" before). */
export function marketTicks(decisions: { t: number; summary: string | null | undefined }[]): WriteTick[] {
  const ticks: WriteTick[] = []
  for (const d of decisions) {
    const s = d.summary ?? ''
    if (/\((held|no write): (cooldown|deadband)/.test(s)) ticks.push({ t: d.t, kind: 'held' })
    else if (marketMark(s)?.wrote) ticks.push({ t: d.t, kind: 'wrote' })
    else if (s.startsWith('Would: ') && /: (set '|feed-in )/.test(s)) ticks.push({ t: d.t, kind: 'would' })
  }
  return ticks.sort((a, b) => a.t - b.t)
}

/** How the decisions in a stretch compared with the automation, in words; null without decisions. */
export function sessionCompared(d: Pick<SessionStretch, 'decisions' | 'same' | 'differs'>): string | null {
  const n = d.decisions
  const decisions = (k: number) => `${k} decision${k === 1 ? '' : 's'}`
  if (n === 0) return null
  if (d.differs > 0) return `${d.differs} of ${decisions(n)} differed from the automation.`
  if (d.same === n && n === 1) return 'The automation did the same.'
  if (d.same === n) return `The automation did the same in all ${decisions(n)}.`
  if (d.same > 0) return `The automation did the same in ${d.same} of ${decisions(n)}; the rest weren't compared.`
  return `${decisions(n)}, not compared.`
}
