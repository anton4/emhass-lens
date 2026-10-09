// Inverter control (experimental): shapes of the backend's free-form inverter data, and helpers to
// show decisions, comparisons and agreement. See backend/emhass_lens/domain/inverter.py.

import type { LampColor } from '../components/Lamp'
import type { Agreement, InverterSettings, RunSummary } from '../api/types'

export interface InverterTargets {
  state: string
  grid_power_w: number
  battery_max_w: number
  battery_min_w: number
}

export interface InverterDecision {
  rule: string // the automation's mode name, e.g. "force_charge" ("a".."i" or "none" in runs made before 0.2.11)
  label: string
  why: string
  targets: InverterTargets | null // null only in runs made before 0.2.11
  feedin_max_w: number
  feedin_why: string
  notes?: string[]
}

/** status.last: the newest decision. */
export interface InverterLast {
  slot: string
  decision: InverterDecision
  source: string
  run_id: number
  blocked: string | null
}

export interface CompareField {
  field: string
  decided: string | number | null
  observed: string | number | null
  same: boolean
}

/** status.last_compare, the `comparison` artifact (with slot) and the `readback` artifact (without). */
export interface InverterComparison {
  slot?: string
  agree: boolean
  fields: CompareField[]
  decision_run_id?: number
}

/** The plan values a decision was made from (EMHASS signs). */
export interface PlanValues {
  p_batt: number
  p_grid: number
  p_pv: number
  p_pv_curtailment: number
  export_price: number | null
}

export interface ObservedValues {
  state: string | null
  grid_power_w: number | null
  battery_max_w: number | null
  battery_min_w: number | null
  feedin_max_w: number | null
}

/** The `decision` artifact of an inverter.decide run. */
export interface DecisionArtifact extends InverterLast {
  values: PlanValues
  observed_before: ObservedValues
}

/** One entry of the `calls` artifact of a live inverter.decide run. */
export interface InverterCall {
  service: string
  entity_id?: string
  value?: number
  option?: string
  ok: boolean
  error?: string
}

export function inverterModeSpec(mode: string | null | undefined): { color: LampColor; text: string; explain: string } {
  switch (mode) {
    case 'live':
      return {
        color: 'red',
        text: 'Live: controls the inverter',
        explain: 'EMHASS Lens sets the inverter itself each slot. Turn the Home Assistant automation off, or both write.',
      }
    case 'dry_run':
      return {
        color: 'blue',
        text: 'Dry run',
        explain: 'Decides each slot and compares with what the Home Assistant automation set. Never touches the inverter.',
      }
    default:
      return { color: 'neutral', text: 'Off', explain: 'Inverter control is off. Nothing is decided or compared.' }
  }
}

/** "7 of 8 slots (88 %)", or a note when nothing has been compared yet. */
export function formatAgreement(a: Agreement | null | undefined): { text: string; percent: string; color: LampColor } {
  if (!a || a.compared === 0 || a.rate === null || a.rate === undefined) {
    return { text: 'No comparisons yet', percent: '—', color: 'neutral' }
  }
  const pct = Math.round(a.rate * 100)
  const color: LampColor = pct >= 99 ? 'green' : pct >= 90 ? 'amber' : 'red'
  return { text: `${a.agreed} of ${a.compared} slot${a.compared === 1 ? '' : 's'} agreed`, percent: `${pct} %`, color }
}

/** Rule id and label from a decide run's summary, e.g. "Would set 'Force charge' (rule force_charge): …". */
export function parseDecisionSummary(summary: string | null | undefined): { rule: string; label: string } | null {
  if (!summary) return null
  const match = /'([^']+)' \(rule ([a-z_]+)\)/.exec(summary)
  if (match) return { rule: match[2]!, label: match[1]! }
  if (summary.includes('no passive-mode change')) return { rule: 'none', label: 'No change' }
  return null
}

/** A decide run that didn't act because the automation wasn't in control (e.g. an mFRR session) reads better as that
 * than as "Nothing to do". Returns null for every other run (use the normal outcome chip). */
export function decideChip(run: Pick<RunSummary, 'outcome' | 'summary'>): { color: LampColor; text: string } | null {
  if (run.outcome === 'noop' && run.summary?.startsWith('Not in control')) return { color: 'amber', text: 'Not in control' }
  return null
}

const SLOT_MS = 15 * 60 * 1000

/** Start of the quarter-hour slot a run belongs to (ms since epoch). */
export function runSlot(run: Pick<RunSummary, 'scheduled_at' | 'started_at'>): number {
  const t = Date.parse(run.scheduled_at ?? run.started_at)
  return Math.floor(t / SLOT_MS) * SLOT_MS
}

export interface HistoryRow {
  slot: number
  decide?: RunSummary
  compare?: RunSummary
}

/** Decide and compare runs side by side, one row per slot, newest first. The newest run of a slot wins. */
export function mergeBySlot(decides: RunSummary[], compares: RunSummary[]): HistoryRow[] {
  const rows = new Map<number, HistoryRow>()
  const put = (run: RunSummary, kind: 'decide' | 'compare') => {
    const slot = runSlot(run)
    const row = rows.get(slot) ?? { slot }
    const existing = row[kind]
    if (!existing || existing.id < run.id) row[kind] = run
    rows.set(slot, row)
  }
  for (const run of decides) put(run, 'decide')
  for (const run of compares) put(run, 'compare')
  return [...rows.values()].sort((a, b) => b.slot - a.slot)
}

export const FIELD_LABELS: Record<string, string> = {
  state: 'Passive state',
  grid_power_w: 'Grid power',
  battery_max_w: 'Battery max',
  battery_min_w: 'Battery min',
  feedin_max_w: 'Feed-in max',
}

export function fieldValue(field: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (field === 'state' || typeof value === 'string') return String(value)
  return `${Math.round(value)} W`
}

export interface RuleText {
  id: string
  label: string
  when: string
  sets: string
}

/** The rules in the automation's order (importing, exporting, neutral), with the thresholds from the current limits
 * (Settings → Inverter control). "Self-use battery or PV" appears twice because two branches end there. */
export function rules(limits: InverterSettings['limits'] | undefined): RuleText[] {
  const l = limits ?? {
    battery_max_w: 20000,
    battery_min_w: -20000,
    grid_import_max_w: 18800,
    export_max_w: 15500,
    export_only_battery_min_w: -16000,
    force_charge_battery_min_w: -3000,
    force_charge_grid_cap_above_w: 9000,
    force_charge_grid_margin_w: 1000,
    low_export_price: 0.03,
  }
  const full = `battery ${l.battery_min_w}…${l.battery_max_w} W`
  const price = `${l.low_export_price} €/kWh`
  return [
    {
      id: 'force_charge',
      label: 'Force charge',
      when: 'Importing (P_grid > 100 W) and charging the battery (P_batt < −100 W)',
      sets: `grid target = ${l.grid_import_max_w} W if P_grid > ${l.force_charge_grid_cap_above_w} W, else P_grid rounded to 100 W + ${l.force_charge_grid_margin_w} W; battery ${l.force_charge_battery_min_w}…${l.battery_max_w} W`,
    },
    {
      id: 'use_bat_import',
      label: 'Self-use battery or PV',
      when: 'Importing and discharging the battery (P_batt > 100 W): use the battery, import the rest',
      sets: `grid 0 W, ${full}`,
    },
    {
      id: 'use_only_grid',
      label: 'Use only grid power',
      when: 'Importing, battery idle (−100…100 W)',
      sets: `grid 0 W, battery 0…${l.battery_max_w} W (no charging)`,
    },
    {
      id: 'charge_export',
      label: 'Charge battery and export some to grid',
      when: 'Exporting (P_grid < −100 W) and charging the battery',
      sets: `grid 0 W, ${full}`,
    },
    {
      id: 'force_discharge',
      label: 'Force discharge',
      when: 'Exporting and discharging the battery',
      sets: `grid target = P_grid rounded to 100 W (negative); ${full}`,
    },
    {
      id: 'self_use_pv_export',
      label: 'Self-use PV and export excess to grid',
      when: `Exporting, battery idle, export price above ${price}`,
      sets: `grid 0 W, battery ${l.export_only_battery_min_w}…0 W (may charge, not discharge)`,
    },
    {
      id: 'self_use',
      label: 'Self-use battery or PV',
      when: `Exporting, battery idle, export price at or below ${price} (an unknown price counts as 0): keep the PV`,
      sets: `grid 0 W, ${full}`,
    },
    {
      id: 'self_use_restrict',
      label: 'Self-use battery or PV, restrict export to grid',
      when: 'Grid neutral (−100…100 W) and PV is curtailed',
      sets: `grid 0 W, ${full}`,
    },
    {
      id: 'self_use',
      label: 'Self-use battery or PV',
      when: 'Grid neutral, no curtailment',
      sets: `grid 0 W, ${full}`,
    },
  ]
}

export function feedinRules(limits: InverterSettings['limits'] | undefined): string[] {
  const price = limits?.low_export_price ?? 0.03
  const max = limits?.export_max_w ?? 15500
  return [
    `0 W when the slot's export price is at or below ${price} €/kWh (an unknown price counts as 0)`,
    `otherwise ${max} W (the export maximum)`,
  ]
}
