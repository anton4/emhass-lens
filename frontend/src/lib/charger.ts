// EV charger control (experimental): shapes of the backend's free-form charger data, and helpers to show
// decisions, comparisons and the rules. See backend/emhass_lens/domain/charger.py.

import type { LampColor } from '../components/Lamp'
import type { ChargerSettings, RunSummary } from '../api/types'
import { formatTime } from './format'
import type { CompareField, RuleText } from './inverter'

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
