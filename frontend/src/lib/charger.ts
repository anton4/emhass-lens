// EV charger control (experimental): shapes of the backend's free-form charger data, and helpers to show
// decisions, comparisons and the rules. See backend/emhass_lens/domain/charger.py.

import type { LampColor } from '../components/Lamp'
import type { ChargerSettings, PlanResponse, RunSummary } from '../api/types'
import { dayTimeLabel } from './chartTime'
import { dayKey, formatTime } from './format'
import type { CompareField, RuleText } from './inverter'
import { NO_SETTINGS_FILL, NO_SETTINGS_INK, NOT_IN_CONTROL_FILL } from './inverter'
import type { Stretch, StripInput, StripMark, WriteTick } from './dayStrip'

export interface ChargerDerived {
  pv_power_w: number
  pv_source: string // actual | potential
  pv_age_s: number
  charger_commanded_w: number
  other_load_w: number
  solar_target_a: number
  emhass_current_a: number | null
}

export interface ChargerDecision {
  rule: string // soc_limit | emhass_* | solar_* | none
  action: string // stop_soc | set_current | start | pause | none
  label: string
  why: string
  target_current_a: number | null
  notify: string | null
  derived: ChargerDerived
  notes?: string[]
}

export interface ChargerInputs {
  charge_mode: string | null
  state_raw: number
  current_limit_a: number
  soc: number
  target_soc: number | null
  p_deferrable0_w: number | null
  solar_limit_a: number
  pv_actual_w: number
  pv_actual_updated: string | null
  pv_potential_w: number
  pv_potential_updated: string | null
  house_load_w: number
}

/** status.last: the newest decision. */
export interface ChargerLast {
  at: string
  slot: string
  trigger: string
  source: string
  decision: ChargerDecision
  inputs: ChargerInputs
  run_id: number
  blocked: string | null
}

export interface ChargerObserved {
  current_limit_a: number | null
  state_raw: number | null
  target_soc: number | null
}

export interface SocClock {
  since: string | null
  fired: boolean
  due_at: string | null
}

/** The `charger_decision` artifact of a charger.decide run. */
export interface ChargerDecisionArtifact extends ChargerLast {
  observed_before: ChargerObserved
  soc: SocClock
}

/** One entry of the `charger_calls` artifact. */
export interface ChargerCall {
  service: string
  entity_id?: string
  value?: number
  message?: string
  ok: boolean | null
  error?: string
  skipped?: string
  dry_run?: boolean
}

/** status.last_compare and the `charger_comparison` / `charger_readback` artifacts. */
export interface ChargerComparison {
  at?: string
  agree: boolean
  fields: CompareField[]
  charging_state?: number | null
  decision_run_id?: number
  attempts?: number
  unexpected?: { from: number; to: number; at: string }
}

/** status.last_tick: what the minute check last concluded. */
export interface ChargerTick {
  at: string
  rule: string
  why: string
  derived: ChargerDerived
  source: string
}

export function chargerModeSpec(mode: string | null | undefined): { color: LampColor; text: string; explain: string } {
  switch (mode) {
    case 'live':
      return {
        color: 'red',
        text: 'Live: controls the charger',
        explain: 'EMHASS Lens drives the EV charger itself. Turn the Home Assistant automation off, or both write.',
      }
    case 'dry_run':
      return {
        color: 'blue',
        text: 'Dry run',
        explain: 'Decides like the automation and compares with what it did to the charger. Never touches the charger.',
      }
    default:
      return { color: 'neutral', text: 'Off', explain: 'EV charger control is off. Nothing is decided or compared.' }
  }
}

const RULE = /'([^']+)' \((soc_limit|emhass_[a-z]+|solar_[a-z]+)\)/

export interface ParsedChargerSummary {
  rule: string
  label: string
  /** What it does to the charger, e.g. "limit 12 A" or "press start, limit 8 A"; for "none", why nothing. */
  action: string | null
  /** The values it was decided from, e.g. "was 10 A, PV 8.3 kW (actual), …" (summaries from 0.3.9 on). */
  facts: string | null
}

/** Split "<head> · <facts>[; the notification failed]" into its two parts. */
function splitFacts(text: string): [string, string | null] {
  const at = text.indexOf(' · ')
  if (at < 0) return [text.replace(/; the notification failed$/, ''), null]
  return [text.slice(0, at), text.slice(at + 3).replace(/; the notification failed$/, '')]
}

/** Rule id, label, action and the numbers behind it from a decide run's summary, e.g.
 * "Would 'Excess solar: adjust the current' (solar_adjust): limit 12 A · was 10 A, PV 8.3 kW (actual), …". */
export function parseChargerSummary(summary: string | null | undefined): ParsedChargerSummary | null {
  if (!summary) return null
  const match = RULE.exec(summary)
  if (match) {
    const [head, facts] = splitFacts(summary.slice(match.index + match[0].length).replace(/^: /, ''))
    const action = head.replace(/ \(control is off\)$/, '').trim() || null
    return { rule: match[2]!, label: match[1]!, action, facts }
  }
  if (summary.startsWith('Nothing to do')) {
    const [head, facts] = splitFacts(summary.replace(/^Nothing to do:?\s*/, ''))
    return { rule: 'none', label: 'Nothing to do', action: head || null, facts }
  }
  return null
}

// a pause in its mode's colour, light
const paused = (color: string) => `color-mix(in srgb, var(${color}) 35%, var(--surface))`

/** The EV charger strip's tones: the plan's charging in the EV colour, excess solar in PV's, a pause in a light shade
 *  of its mode's, the target-SoC stop in the state of charge's, plugged in neutral, unplugged hatched faintly (its
 *  name on a chip). */
const CHARGER_TONES = {
  plan: { key: 'EMHASS: charging', fill: 'var(--q-ev)', ink: 'var(--on-q-ev)' },
  planPaused: { key: 'EMHASS: paused', fill: paused('--q-ev'), ink: 'var(--ink)' },
  solar: { key: 'Excess solar: charging', fill: 'var(--q-pv)', ink: 'var(--on-q-pv)' },
  solarPaused: { key: 'Excess solar: paused', fill: paused('--q-pv'), ink: 'var(--ink)' },
  soc: { key: 'Target SoC: stop', fill: 'var(--q-soc)', ink: 'var(--on-q-soc)' },
  plugged: { key: 'Plugged in', fill: NO_SETTINGS_FILL, ink: NO_SETTINGS_INK },
  unplugged: { key: 'Unplugged', fill: 'var(--plug-unplugged)', ink: null },
  none: { key: 'Nothing to do', fill: NO_SETTINGS_FILL, ink: NO_SETTINGS_INK },
} satisfies Record<string, { key: string; fill: string; ink: string | null }>

/** The EV charger strip's key entries, in order. */
export const CHARGER_KEYS = [
  'EMHASS: charging',
  'EMHASS: paused',
  'Excess solar: charging',
  'Excess solar: paused',
  'Target SoC: stop',
  'Plugged in',
  'Unplugged',
  'Nothing to do',
  'Not in control',
]

/** What a charger decision was made from (its facts since 0.5.3): the charge mode, the charging state ("unplugged",
 *  "charging", "plugged in", "state 3") and the plan's EV power in W. Null where the summary doesn't say. */
export interface ChargerFacts {
  mode: string | null
  state: string | null
  planW: number | null
}

const FACTS = /(?:^|· )mode ([^,]+), (unplugged|charging|plugged in|state [^,]+), was /

export function chargerFacts(summary: string | null | undefined): ChargerFacts {
  const s = summary ?? ''
  const m = FACTS.exec(s)
  const plan = /, plan (-?\d+(?:\.\d+)?) kW/.exec(s)
  return {
    mode: m && m[1] !== 'unknown' ? m[1]! : null,
    state: m ? m[2]! : null,
    planW: plan ? Number(plan[1]) * 1000 : null,
  }
}

const RULE_MARK: Record<string, { label: string; tone: keyof typeof CHARGER_TONES }> = {
  emhass_start: { label: 'charging · plan', tone: 'plan' },
  emhass_adjust: { label: 'charging · plan', tone: 'plan' },
  emhass_pause: { label: 'paused · plan', tone: 'planPaused' },
  solar_start: { label: 'charging · excess solar', tone: 'solar' },
  solar_adjust: { label: 'charging · excess solar', tone: 'solar' },
  solar_pause: { label: 'paused · excess solar', tone: 'solarPaused' },
  soc_limit: { label: 'target SoC reached', tone: 'soc' },
}

/** A charger decision on the EV charger page's day strip, named by what the charger was doing: "charging · plan" (with
 *  the plan's power as `amount`), "charging · excess solar", "paused · plan", "plugged in · waiting", "plugged in ·
 *  done", "unplugged", "target SoC reached"; a decision with nothing to do takes the charging state it saw.
 *  `title` heads its popup; `wrote`: it wrote to the charger (live: "Did …"); `would`: a dry run would have. Null for
 *  summaries without a rule. */
export function chargerMark(
  summary: string | null | undefined,
): (StripMark & { title: string; amount: number | null; would: boolean }) | null {
  if (!summary) return null
  const parsed = parseChargerSummary(summary)
  if (summary.startsWith('Not in control')) {
    const title = parsed ? `Not in control; would: ${parsed.label}` : 'Not in control'
    const blocked = { label: 'not in control', key: 'Not in control', fill: NOT_IN_CONTROL_FILL, ink: null }
    return { ...blocked, wrote: false, would: false, title, amount: null }
  }
  if (!parsed) return null
  const facts = chargerFacts(summary)
  const solarMode = /solar/i.test(facts.mode ?? '')
  const ruled = RULE_MARK[parsed.rule]
  const [label, tone] = ruled
    ? [ruled.label, ruled.tone]
    : facts.state === 'charging'
      ? solarMode
        ? ['charging · excess solar', 'solar' as const]
        : ['charging · plan', 'plan' as const]
      : facts.state === 'plugged in'
        ? [/at the target/.test(parsed.action ?? '') ? 'plugged in · done' : 'plugged in · waiting', 'plugged' as const]
        : facts.state === 'unplugged'
          ? ['unplugged', 'unplugged' as const]
          : ['nothing to do', 'none' as const]
  const t = CHARGER_TONES[tone]
  const wrote = /(^|· )Did /.test(summary)
  const would = parsed.rule !== 'none' && summary.startsWith('Would ')
  const amount = tone === 'plan' && facts.planW !== null && facts.planW > 0 ? facts.planW : null
  return { label, key: t.key, fill: t.fill, ink: t.ink, wrote, would, title: parsed.label, amount }
}

/** The EV charger's "Lens wrote" row from its decisions: each write (live), each change a dry run would have made,
 *  each decision held while EMHASS Lens wasn't in control, and a "nothing to do" where the charging state changed
 *  (the car plugged in or left). */
export function chargerTicks(decisions: { t: number; summary: string | null | undefined }[]): WriteTick[] {
  const ticks: WriteTick[] = []
  let state: string | null = null
  for (const d of [...decisions].sort((a, b) => a.t - b.t)) {
    const mark = chargerMark(d.summary)
    if (!mark) continue
    const seen = chargerFacts(d.summary).state
    if (mark.wrote) ticks.push({ t: d.t, kind: 'wrote' })
    else if (mark.key === 'Not in control') ticks.push({ t: d.t, kind: 'held' })
    else if (mark.would) ticks.push({ t: d.t, kind: 'would' })
    else if (seen !== null && state !== null && seen !== state) ticks.push({ t: d.t, kind: 'noop' })
    state = seen ?? state
  }
  return ticks
}

/** The EV charger's rest of the day from the plan in force: where EMHASS plans to charge the car (P_deferrable0, its
 *  power as `amount`) and, between, "next plan: Sat 03:00–05:30" (or "nothing planned" after the last charge). From
 *  the slot that ends after `now` to the end of the plan; nothing when the plan has no EV load. */
export function chargerAhead(
  plan: PlanResponse | null | undefined,
  now: number,
  timeZone: string,
): StripInput<Stretch>[] {
  const snap = plan?.current
  if (!snap || !snap.rows.some((r) => 'P_deferrable0' in r)) return []
  const runs: { from: number; until: number; charging: boolean; w: number }[] = []
  const slots = snap.rows
    .map((r) => ({ t: Date.parse(String(r.timestamp)) / 1000, w: Number(r.P_deferrable0 ?? 0) || 0 }))
    .filter((s) => Number.isFinite(s.t) && s.t + 900 > now)
    .sort((a, b) => a.t - b.t)
  for (const s of slots) {
    const charging = s.w > 1
    const last = runs.at(-1)
    if (last && last.charging === charging && last.until === s.t) {
      last.until += 900
      last.w = Math.max(last.w, s.w)
    } else {
      runs.push({ from: s.t, until: s.t + 900, charging, w: s.w })
    }
  }
  const today = dayKey(new Date(now * 1000), timeZone)
  const clock = (t: number) => dayTimeLabel(t, timeZone).slice(-5)
  // "03:00–05:30" today, "Sat 03:00–05:30" on another day
  const when = (r: { from: number; until: number }) => {
    const start = dayKey(new Date(r.from * 1000), timeZone) === today ? clock(r.from) : dayTimeLabel(r.from, timeZone)
    return `${start}–${clock(r.until)}`
  }
  const made = snap.run_id ? ` (the plan of run ${snap.run_id})` : ''
  return runs.map((r, i) => {
    const stretch = { from: r.from, last: r.until, decisions: 0, same: 0, differs: 0 }
    if (r.charging) {
      const kw = `${(r.w / 1000).toFixed(1)} kW`
      const fill = CHARGER_TONES.plan.fill
      return {
        t: r.from,
        span: r.until - r.from,
        label: 'charging · plan',
        fill,
        amount: r.w,
        detail: { ...stretch, title: 'Charging planned', fill, planned: `EMHASS plans up to ${kw} for the car${made}.` },
      }
    }
    const next = runs.slice(i + 1).find((n) => n.charging)
    return {
      t: r.from,
      span: r.until - r.from,
      label: next ? `next plan: ${when(next)}` : 'nothing planned',
      fill: NO_SETTINGS_FILL,
      detail: {
        ...stretch,
        title: next ? `Next charge planned ${when(next)}` : 'No charging in the plan',
        fill: NO_SETTINGS_FILL,
        planned: `Nothing for the car until then${made}.`,
      },
    }
  })
}

/** The decision id a compare run's summary refers to ("Decision #12: …"). */
export function decisionRef(summary: string | null | undefined): number | null {
  const match = /Decision #(\d+)/.exec(summary ?? '')
  return match ? Number(match[1]) : null
}

/** The target-SoC clock in words: below the target, at it since when and when the stop is due, or done. */
export function socClockText(clock: SocClock | undefined, tz?: string): string {
  if (!clock || !clock.since) return 'below the target'
  const since = formatTime(clock.since, new Date(), tz)
  if (clock.fired) return `at the target since ${since}; the stop was done`
  return `at the target since ${since}; stop due ${formatTime(clock.due_at, new Date(), tz)}`
}

export function chargerStateText(state: number | null | undefined): string {
  if (state === null || state === undefined) return '—'
  if (state === 0) return 'unplugged (0)'
  if (state === 4) return 'charging (4)'
  if (state === 1 || state === 2 || state === 5) return `plugged in (${state})`
  return `state ${state}`
}

export const CHARGER_FIELD_LABELS: Record<string, string> = {
  current_limit_a: 'Current limit',
  target_soc: 'Target SoC',
  state_raw: 'Charging state',
}

export function chargerFieldValue(field: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value
  if (field === 'current_limit_a') return `${Math.round(value)} A`
  if (field === 'target_soc') return `${Math.round(value)} %`
  if (field === 'state_raw') return chargerStateText(value)
  return String(value)
}

export interface DecisionRow {
  decide?: RunSummary
  compare?: RunSummary
  at: string
}

/** Decide runs with the compare run that judged them (by the "Decision #id" in its summary), newest first.
 * Compares without a decision (the automation acted on its own) get a row of their own. */
export function pairCompares(decides: RunSummary[], compares: RunSummary[]): DecisionRow[] {
  const rows = new Map<number, DecisionRow>()
  for (const d of decides) rows.set(d.id, { decide: d, at: d.started_at })
  const loose: DecisionRow[] = []
  for (const c of compares) {
    const ref = decisionRef(c.summary)
    const row = ref === null ? undefined : rows.get(ref)
    if (row && !row.compare) row.compare = c
    else loose.push({ compare: c, at: c.started_at })
  }
  return [...rows.values(), ...loose].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

/** The automation's branches in plain words, with the configured limits. */
export function chargerRules(limits: ChargerSettings['limits'] | undefined): RuleText[] {
  const l = limits ?? {
    min_current_a: 6,
    max_current_a: 16,
    w_per_amp: 690,
    pv_potential_gap_w: 2000,
    pv_stale_s: 600,
    soc_for_s: 300,
    compare_delay_s: 8,
    compare_window_s: 20,
    soc_compare_window_s: 90,
  }
  const minutes = Math.round(l.soc_for_s / 60)
  return [
    {
      id: 'soc_limit',
      label: 'Target SoC reached: stop charging',
      when: `The car's SoC has been at or above the target SoC for ${minutes} min (any mode, any state)`,
      sets: 'press stop, current limit 0 A, a phone message, target SoC back to 100 %',
    },
    {
      id: 'emhass_start',
      label: 'EMHASS: start charging',
      when: `Mode EMHASS, plugged in (state 1, 2 or 5), the plan's EV power above 1 W, SoC below the target`,
      sets: `press start, current limit = plan power ÷ ${l.w_per_amp} W/A, at least ${l.min_current_a} A, at most the maximum current; a phone message`,
    },
    {
      id: 'emhass_adjust',
      label: 'EMHASS: adjust the current',
      when: "Mode EMHASS, charging (state 4), the plan's EV power above 1 W and its current differs from the limit",
      sets: 'current limit = the planned current',
    },
    {
      id: 'emhass_pause',
      label: 'EMHASS: pause charging',
      when: "Mode EMHASS, charging, the plan's EV power below 1 W",
      sets: 'current limit 0 A, a phone message',
    },
    {
      id: 'solar_start',
      label: 'Excess solar: start charging',
      when: `Mode Excess Solar, plugged in, (PV − other load) ÷ ${l.w_per_amp} W/A is at least ${l.min_current_a} A`,
      sets: 'press start, current limit = the solar current (capped at the maximum current); a phone message',
    },
    {
      id: 'solar_adjust',
      label: 'Excess solar: adjust the current',
      when: `Mode Excess Solar, charging, the solar current is at least ${l.min_current_a} A and differs from the limit`,
      sets: 'current limit = the solar current',
    },
    {
      id: 'solar_pause',
      label: 'Excess solar: pause charging',
      when: `Mode Excess Solar, charging, the solar current is below ${l.min_current_a} A`,
      sets: 'current limit 0 A, a phone message',
    },
  ]
}

/** The three formulas behind the rules, with the configured limits. */
export function chargerFormulas(limits: ChargerSettings['limits'] | undefined): string[] {
  const gap = limits?.pv_potential_gap_w ?? 2000
  const stale = limits?.pv_stale_s ?? 600
  const wpa = limits?.w_per_amp ?? 690
  return [
    `PV = the potential PV when it is more than ${gap} W above the measured PV (the inverter is curtailing), otherwise the measured PV.`,
    `Other load = house load − the charger's own draw (current limit × ${wpa} W while charging or paused in state 5), never below 0.`,
    `Solar current = (PV − other load) ÷ ${wpa} W/A rounded down; it never rises above the current limit while the PV data is older than ${Math.round(stale / 60)} min.`,
  ]
}
