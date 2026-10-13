// Inverter control (experimental): shapes of the backend's free-form inverter data, and helpers to
// show decisions, comparisons and agreement. See backend/emhass_lens/domain/inverter.py.

import type { LampColor } from '../components/Lamp'
import type { Agreement, ButtonPress, InverterSettings, RunSummary } from '../api/types'
import type { StripInput } from './dayStrip'

export interface InverterTargets {
  state: string
  grid_power_w: number
  battery_max_w: number
  battery_min_w: number
}

export interface InverterDecision {
  rule: string // the automation's mode name, e.g. "force_charge" ("a".."i" or "none" in runs made before 0.2.11)
  branch?: string // which rule matched (RuleText.key); two rules end in the mode self_use (missing in older runs)
  label: string
  why: string
  targets: InverterTargets | null // null only in runs made before 0.2.11
  feedin_max_w: number // the limit for the slot's export price (or the one kept, see feedin_floor_w)
  feedin_why: string
  notes?: string[]
  feedin_needed?: boolean // false: nothing can reach the grid, the limit is left as it is (missing before 0.4.8)
  feedin_floor_w?: number | null // export allowed: any limit from here to feedin_ceiling_w serves the slot (missing in older runs)
  feedin_ceiling_w?: number | null
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

/** One entry of the `calls` artifact of a live inverter.decide run (and of the charger's `charger_calls`, where
 * notifications carry a message and dry-run entries have ok null). */
export interface InverterCall {
  service: string
  entity_id?: string
  value?: number
  option?: string
  message?: string
  ok: boolean | null
  error?: string
  skipped?: string
  dry_run?: boolean
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

/** The settings a decide run set (or would set), as its summary names them. */
export interface DecisionTargets {
  rule: string
  state: string
  grid_power_w: number
  battery_min_w: number
  battery_max_w: number
  feedin_max_w: number | null // null: the limit was left as it is
}

const TARGETS = /'([^']+)' \(rule ([a-z_]+)\): grid (-?\d+) W, battery (-?\d+)…(-?\d+) W, feed-in (?:(-?\d+) W|unchanged)/

/** The settings from a decide run's summary, e.g. "Would set 'Force charge' (rule force_charge): grid 5600 W,
 * battery -3000…20000 W, feed-in 0 W" ("feed-in unchanged" when the limit is left as it is). Null for runs without
 * settings (nothing to decide, refused) and for runs made before the summary named them. */
export function parseDecisionTargets(summary: string | null | undefined): DecisionTargets | null {
  const m = summary ? TARGETS.exec(summary) : null
  if (!m) return null
  return {
    state: m[1]!,
    rule: m[2]!,
    grid_power_w: Number(m[3]),
    battery_min_w: Number(m[4]),
    battery_max_w: Number(m[5]),
    feedin_max_w: m[6] === undefined ? null : Number(m[6]),
  }
}

export interface DecisionAction {
  /** would: dry run; set: written (live); already: live, nothing to write; blocked: not in control */
  kind: 'would' | 'set' | 'already' | 'blocked'
  /** Why EMHASS Lens wasn't in control (blocked). */
  reason?: string
  /** What had drifted when a drift check set the settings back. */
  drift?: string
}

/** What a decide run did with its decision, from its summary's opening words. */
export function decisionAction(summary: string | null | undefined): DecisionAction | null {
  if (!summary) return null
  const drift = /^Drift: (.*?); set back · (.*)$/.exec(summary)
  if (drift) {
    const inner = decisionAction(drift[2])
    return inner && { ...inner, drift: drift[1] }
  }
  const blocked = /^Not in control \((.*)\); would: /.exec(summary)
  if (blocked) return { kind: 'blocked', reason: blocked[1] }
  if (summary.startsWith('Would set ')) return { kind: 'would' }
  if (summary.startsWith('Already set: ')) return { kind: 'already' }
  if (summary.startsWith('Set ')) return { kind: 'set' }
  return null
}

/** Where the automation set something else, by field, from a compare run's summary ("Differs — grid_power_w:
 * decided 5600, automation set 5000.0; …"), formatted for display. Empty when it did the same. */
export function compareDiffs(summary: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!summary?.startsWith('Differs — ')) return out
  for (const part of summary.slice('Differs — '.length).split('; ')) {
    const m = /^([a-z_]+): decided (.*), automation set (.*)$/.exec(part)
    if (!m) continue
    const field = m[1]!
    const raw = m[3]!
    const n = Number(raw)
    out[field] = raw === 'None' ? '—' : field !== 'state' && raw !== '' && Number.isFinite(n) ? fieldValue(field, n) : raw
  }
  return out
}

export interface ModeTone {
  state: string // the passive state, the automation's input_select option
  short: string
  fill: string // CSS background
}

/** The passive states from importing to exporting, as the day strip shows them. The colours are the --mode-* tokens,
 * checked together for colour-vision deficiency in both themes. */
export const MODE_TONES: ModeTone[] = [
  { state: 'Force charge', short: 'Force charge', fill: 'var(--mode-force-charge)' },
  { state: 'Use only grid power', short: 'Grid only', fill: 'var(--mode-grid-only)' },
  { state: 'Self-use battery or PV', short: 'Self-use', fill: 'var(--mode-self-use)' },
  {
    state: 'Self-use battery or PV, restrict export to grid',
    short: 'Restrict export',
    fill: 'var(--mode-restrict-export)',
  },
  { state: 'Charge battery and export some to grid', short: 'Charge + export', fill: 'var(--mode-charge-export)' },
  { state: 'Self-use PV and export excess to grid', short: 'PV export', fill: 'var(--mode-pv-export)' },
  { state: 'Force discharge', short: 'Force discharge', fill: 'var(--mode-force-discharge)' },
]

/** The state most slots are in: its name gives way to the others on the strip. */
export const EVERYDAY_STATE = 'Self-use battery or PV'
export const NOT_IN_CONTROL_FILL = 'var(--mode-blocked)'
export const NO_SETTINGS_FILL = 'var(--line-neutral)'

export function modeTone(state: string): ModeTone {
  return MODE_TONES.find((m) => m.state === state) ?? { state, short: state, fill: NO_SETTINGS_FILL }
}

/** One slot of the inverter's day strip, for its popup. */
export interface SlotDetail {
  slot: number // ms, the start of the quarter-hour
  targets: DecisionTargets | null
  action: DecisionAction | null
  summary: string | null // the decide run's, shown when there are no settings
  /** Settings that differ from the slot before (the feed-in limit: from the last one set). */
  changed: string[]
  /** The feed-in limit set earlier today and since when, for a slot that left it as it is. */
  feedinBefore: { value: number; slot: number } | null
  /** Where the automation set something else: field → what it set. */
  differs: Record<string, string>
  compare: string | null // the compare run's outcome: ok, mismatch, noop
  /** The Sofar button presses within the slot, oldest first: ours and anyone else's. */
  presses?: ButtonPress[]
}

const SETTINGS = ['state', 'grid_power_w', 'battery_min_w', 'battery_max_w'] as const

/** The line under the inverter's strip. */
export const STRIP_BAND = { same: 'var(--line-green)', differs: 'var(--lamp-amber)', wrote: 'var(--ink-2)' }

/** The inverter's day strip from mergeBySlot rows: each slot coloured by its passive state (hatched where EMHASS Lens
 * wasn't in control), and the line under it showing the comparison (dry run) or a write (live). */
export function inverterStrip(rows: HistoryRow[]): StripInput<SlotDetail>[] {
  const out: StripInput<SlotDetail>[] = []
  // the last settings EMHASS Lens was in control of, and the last feed-in limit set
  const last: { targets: DecisionTargets | null; feedin: SlotDetail['feedinBefore'] } = { targets: null, feedin: null }
  for (const row of [...rows].sort((a, b) => a.slot - b.slot)) {
    const summary = row.decide?.summary ?? null
    const targets = parseDecisionTargets(summary)
    const action = decisionAction(summary)
    const blocked = action?.kind === 'blocked'
    const before = last.targets
    const changed: string[] = []
    if (targets) {
      if (before) changed.push(...SETTINGS.filter((f) => before[f] !== targets[f]))
      if (targets.feedin_max_w !== null && targets.feedin_max_w !== last.feedin?.value) changed.push('feedin_max_w')
    }
    const detail: SlotDetail = {
      slot: row.slot,
      targets,
      action,
      summary,
      changed,
      feedinBefore: last.feedin,
      differs: compareDiffs(row.compare?.summary),
      compare: row.compare?.outcome ?? null,
    }
    if (targets && !blocked) {
      last.targets = targets
      if (targets.feedin_max_w !== null && changed.includes('feedin_max_w')) {
        last.feedin = { value: targets.feedin_max_w, slot: row.slot }
      }
    }
    const tone = targets ? modeTone(targets.state) : null
    const compare = detail.compare
    out.push({
      t: row.slot / 1000,
      compare,
      label: blocked ? 'Not in control' : (tone?.short ?? null),
      quiet: targets?.state === EVERYDAY_STATE && !blocked,
      runId: row.decide?.id ?? row.compare?.id,
      fill: blocked ? NOT_IN_CONTROL_FILL : (tone?.fill ?? NO_SETTINGS_FILL),
      band:
        compare === 'ok'
          ? STRIP_BAND.same
          : compare === 'mismatch'
            ? STRIP_BAND.differs
            : action?.kind === 'set'
              ? STRIP_BAND.wrote
              : null,
      detail,
    })
  }
  return out
}

/** The strip's key: each passive state seen (in MODE_TONES order, unknown ones after), then the slots not in control
 * and those without settings, with how many slots each. */
export function inverterLegend(inputs: StripInput<SlotDetail>[]): { text: string; fill: string; count: number }[] {
  const states = new Map<string, number>()
  let blocked = 0
  let none = 0
  for (const { detail } of inputs) {
    if (detail?.action?.kind === 'blocked') blocked++
    else if (detail?.targets) states.set(detail.targets.state, (states.get(detail.targets.state) ?? 0) + 1)
    else none++
  }
  const known = MODE_TONES.map((m) => m.state)
  const unknown = [...states.keys()].filter((s) => !known.includes(s)).sort()
  const out = [...known, ...unknown].flatMap((state) => {
    const count = states.get(state)
    return count ? [{ text: modeTone(state).short, fill: modeTone(state).fill, count }] : []
  })
  if (blocked) out.push({ text: 'Not in control', fill: NOT_IN_CONTROL_FILL, count: blocked })
  if (none) out.push({ text: 'No settings', fill: NO_SETTINGS_FILL, count: none })
  return out
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

/** A rule in plain words (the EV charger's rules use it as it is). */
export interface RuleText {
  id: string
  label: string
  when: string
  sets: string
}

export type RuleGroup = 'import' | 'export' | 'neutral'

/** An inverter rule. Three of them set the passive state "Self-use battery or PV" and two end in the mode self_use, so
 * each has its own key and title. */
export interface InverterRuleText {
  /** As in the decision's `branch`. */
  key: string
  /** The mode, as in the decision's `rule`. */
  id: string
  group: RuleGroup
  title: string
  /** The passive state it sets: the automation's input_select option. */
  state: string
  when: string
  sets: string
}

/** The branches P_grid picks, in the order they are tried. */
export const RULE_GROUPS: { group: RuleGroup; title: string }[] = [
  { group: 'import', title: 'Importing: P_grid above 100 W' },
  { group: 'export', title: 'Exporting: P_grid below −100 W' },
  { group: 'neutral', title: 'Neutral: P_grid −100…100 W' },
]

const SELF_USE = 'Self-use battery or PV'

/** The rules in the automation's order (importing, exporting, neutral), with the thresholds from the current limits
 * (Settings → Inverter control) and the export block (Settings → EMHASS → MPC "No export at or below"; null = never).
 * The battery window is in Sofar's sign (charging positive), the opposite of EMHASS's P_batt. */
export function rules(
  limits: InverterSettings['limits'] | undefined,
  noExportAtOrBelow: number | null,
): InverterRuleText[] {
  const l = limits ?? {
    battery_max_w: 20000,
    battery_min_w: -20000,
    grid_import_max_w: 18800,
    export_max_w: 15500,
    force_charge_at_import_max: true,
    force_charge_grid_cap_above_w: 9000,
    force_charge_grid_margin_w: 1000,
    cap_discharge_at_plan: true,
    cap_charge_at_plan: true,
    battery_cap_slack_w: 500,
    battery_full_soc_pct: 90,
  }
  const full = `battery ${l.battery_min_w}…${l.battery_max_w} W`
  const price = noExportAtOrBelow === null ? null : `${noExportAtOrBelow} €/kWh`
  const forceGrid = l.force_charge_at_import_max
    ? `grid target = ${l.grid_import_max_w} W (the import max; the battery limits its own charge)`
    : `grid target = ${l.grid_import_max_w} W if P_grid > ${l.force_charge_grid_cap_above_w} W, else P_grid rounded to 100 W + ${l.force_charge_grid_margin_w} W`
  const slack = l.battery_cap_slack_w
  const plus = slack ? ` + ${Math.floor(slack / 2)} W` : ''
  const kept = slack ? `; kept while 0–${slack} W above the plan` : ''
  const dischargeSets = l.cap_discharge_at_plan
    ? `grid 0 W, battery min = −(the plan's discharge${plus}) rounded up to 100 W, max ${l.battery_max_w} W: the battery gives what the plan says, the grid the rest${kept}`
    : `grid 0 W, ${full} (the battery covers the whole house)`
  const blocked = price === null ? '' : `. At or below ${price}: ${full}, because the feed-in limit is 0 W there`
  const chargeSets = l.cap_charge_at_plan
    ? `grid 0 W, battery min ${l.battery_min_w} W, max = the plan's charge${plus} rounded up to 100 W: the battery takes what the plan says and the rest is exported${kept}${blocked}`
    : `grid 0 W, ${full} (the battery takes all the surplus)`
  return [
    {
      key: 'force_charge',
      id: 'force_charge',
      group: 'import',
      title: 'Force charge from the grid',
      state: 'Force charge',
      when: 'Charging the battery (P_batt below −100 W)',
      sets: `${forceGrid}; ${full}`,
    },
    {
      key: 'use_bat_import',
      id: 'use_bat_import',
      group: 'import',
      title: 'Use the battery, import the rest',
      state: SELF_USE,
      when: 'Discharging the battery (P_batt above 100 W)',
      sets: dischargeSets,
    },
    {
      key: 'use_only_grid',
      id: 'use_only_grid',
      group: 'import',
      title: 'Use only grid power',
      state: 'Use only grid power',
      when: 'Battery idle (P_batt −100…100 W)',
      sets: `grid 0 W, battery 0…${l.battery_max_w} W (may charge, not discharge: PV first, the grid covers the rest)`,
    },
    {
      key: 'charge_export',
      id: 'charge_export',
      group: 'export',
      title: 'Charge and export',
      state: 'Charge battery and export some to grid',
      when: 'Charging the battery',
      sets: chargeSets,
    },
    {
      key: 'force_discharge',
      id: 'force_discharge',
      group: 'export',
      title: 'Force discharge',
      state: 'Force discharge',
      when: 'Discharging the battery',
      sets: `grid target = P_grid rounded to 100 W (negative); ${full}`,
    },
    {
      key: 'self_use_pv_export',
      id: 'self_use_pv_export',
      group: 'export',
      title: 'Export the PV',
      state: 'Self-use PV and export excess to grid',
      when:
        price === null
          ? 'Battery idle (export is never blocked: "No export at or below" is empty)'
          : `Battery idle, export price above ${price}`,
      sets: `grid 0 W, battery ${l.battery_min_w}…0 W (may discharge, not charge: surplus PV is exported)`,
    },
    {
      key: 'self_use_keep_pv',
      id: 'self_use',
      group: 'export',
      title: 'Keep the PV (export too cheap)',
      state: SELF_USE,
      when:
        price === null
          ? 'Battery idle, export price at or below "No export at or below": never, it is empty'
          : `Battery idle, export price at or below ${price}. Rare: EMHASS plans no export in those slots, so this happens only when the price is unknown (it counts as 0)`,
      sets: `grid 0 W, ${full}`,
    },
    {
      key: 'self_use_restrict',
      id: 'self_use_restrict',
      group: 'neutral',
      title: 'Restrict export (PV curtailed)',
      state: 'Self-use battery or PV, restrict export to grid',
      when: 'PV is curtailed',
      sets: `grid 0 W, ${full}`,
    },
    {
      key: 'self_use',
      id: 'self_use',
      group: 'neutral',
      title: 'Self-use',
      state: SELF_USE,
      when: 'No curtailment',
      sets: `grid 0 W, ${full}`,
    },
  ]
}

/** What EMHASS Lens does differently from the automation with the current limits (dry run differs there too). */
export function deviations(limits: InverterSettings['limits'] | undefined): string[] {
  const out: string[] = []
  if (limits?.force_charge_at_import_max ?? true) {
    out.push('Force charge holds the import max, so back-to-back Force charge slots write nothing.')
  }
  if (limits?.cap_discharge_at_plan ?? true) {
    out.push(
      'Use the battery, import the rest: the battery gives what the plan says instead of covering the whole house, ' +
        'so the energy stays for the dearer slot it was saved for.',
    )
  }
  if (limits?.cap_charge_at_plan ?? true) {
    out.push(
      'Charge and export: the battery takes what the plan says and the rest is exported, so it keeps room for the ' +
        'PV later in the day instead of filling up now.',
    )
  }
  out.push('The feed-in limit is only written when something can reach the grid in the slot.')
  return out
}

export function feedinRules(
  limits: InverterSettings['limits'] | undefined,
  noExportAtOrBelow: number | null,
): string[] {
  const max = limits?.export_max_w ?? 15500
  const full = limits?.battery_full_soc_pct ?? 90
  const written =
    `Written only when something can reach the grid in the slot: the plan exports, curtails PV, or has PV to spare ` +
    `with its state of charge at or above ${full} % (Settings → Inverter control). Otherwise the limit is left as it ` +
    `is, because every press of the feed-in button is an EEPROM write.`
  if (noExportAtOrBelow === null) {
    return [`${max} W (the export maximum) in every slot: "No export at or below" is empty`, written]
  }
  return [
    `0 W when the slot's export price is at or below ${noExportAtOrBelow} €/kWh (an unknown price counts as 0)`,
    `otherwise ${max} W (the export maximum)`,
    written,
  ]
}
