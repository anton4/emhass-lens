// Qilowatt market control (experimental): shapes of the backend's free-form market data, and helpers to show
// decisions, comparisons, sessions and the write throttle. See backend/emhass_lens/domain/market.py.

import type { LampColor } from '../components/Lamp'
import type { MarketSettings, MarketWatchdogStatus, RunSummary } from '../api/types'
import { formatTime } from './format'
import type { CompareField } from './inverter'
import type { InverterTargets } from './inverter'

export interface MarketThrottle {
  grid_delta_w: number
  effective_deadband_w: number
  rails_wrong: boolean
  since_commit_s: number | null
  cooldown_bypass: boolean
  bypass_reasons: string[]
  cooldown_block: boolean
  reasons: string[]
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

/** The gist of a reconcile run's summary: "Would: Kratt sell 5000W", "Kratt sell 7000W: registers unchanged",
 * "Qilowatt safeguard: session ended (mode_cleared) …", "No action: …", "Not in control …". */
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
      text: `The grid target is rewritten only when it moves by more than max(${t.deadband_w} W, ${Math.round(t.deadband_pct * 100)} % of the target).`,
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
