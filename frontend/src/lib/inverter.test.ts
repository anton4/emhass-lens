import { describe, expect, it } from 'vitest'
import type { RunSummary } from '../api/types'
import {
  compareDiffs,
  decideChip,
  decisionAction,
  deviations,
  feedinRules,
  fieldValue,
  formatAgreement,
  inverterLegend,
  inverterStrip,
  mergeBySlot,
  modeTone,
  NOT_IN_CONTROL_FILL,
  NO_SETTINGS_FILL,
  parseDecisionSummary,
  parseDecisionTargets,
  RULE_GROUPS,
  rules,
  runSlot,
  STRIP_BAND,
} from './inverter'

function run(id: number, job: string, startedAt: string, outcome = 'ok', summary: string | null = null): RunSummary {
  return { id, job, trigger: 'schedule', started_at: startedAt, scheduled_at: null, outcome, summary, pinned: 0 }
}

describe('formatAgreement', () => {
  it('says when nothing has been compared', () => {
    expect(formatAgreement(null).text).toBe('No comparisons yet')
    expect(formatAgreement({ hours: 24, compared: 0, agreed: 0, rate: null }).percent).toBe('—')
  })
  it('rounds the rate and colours it', () => {
    expect(formatAgreement({ hours: 24, compared: 8, agreed: 7, rate: 0.875 })).toEqual({
      text: '7 of 8 slots agreed',
      percent: '88 %',
      color: 'red',
    })
    expect(formatAgreement({ hours: 24, compared: 96, agreed: 96, rate: 1 }).color).toBe('green')
    expect(formatAgreement({ hours: 24, compared: 1, agreed: 1, rate: 1 }).text).toBe('1 of 1 slot agreed')
  })
})

describe('parseDecisionSummary', () => {
  it('reads the rule from dry-run and live summaries', () => {
    expect(
      parseDecisionSummary("Would set 'Force charge' (rule force_charge): grid 5600 W, battery -3000…20000 W, feed-in 0 W"),
    ).toEqual({ rule: 'force_charge', label: 'Force charge' })
    expect(parseDecisionSummary("Set 'Self-use battery or PV' (rule self_use): grid 0 W")).toEqual({
      rule: 'self_use',
      label: 'Self-use battery or PV',
    })
    expect(parseDecisionSummary("Set 'Self-use battery or PV' (rule b): grid 0 W")).toEqual({
      rule: 'b',
      label: 'Self-use battery or PV',
    }) // runs made before 0.2.11
    expect(parseDecisionSummary('Would set no passive-mode change (no rule matches); feed-in 15500 W')).toEqual({
      rule: 'none',
      label: 'No change',
    })
    expect(parseDecisionSummary('Nothing to decide: no plan row for this slot')).toBeNull()
  })
})

describe('mergeBySlot', () => {
  it('pairs decide and compare runs of the same slot, newest slot first', () => {
    const decides = [
      run(10, 'inverter.decide', '2026-10-09T11:15:05Z', 'dry_run'),
      run(20, 'inverter.decide', '2026-10-09T11:30:05Z', 'dry_run'),
    ]
    const compares = [run(11, 'inverter.compare', '2026-10-09T11:15:45Z', 'mismatch')]
    const rows = mergeBySlot(decides, compares)
    expect(rows.map((r) => [new Date(r.slot).toISOString(), r.decide?.id, r.compare?.id])).toEqual([
      ['2026-10-09T11:30:00.000Z', 20, undefined],
      ['2026-10-09T11:15:00.000Z', 10, 11],
    ])
  })
  it('keeps the newest run when a slot was decided twice', () => {
    const rows = mergeBySlot(
      [run(5, 'inverter.decide', '2026-10-09T11:15:05Z'), run(7, 'inverter.decide', '2026-10-09T11:20:00Z')],
      [],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decide?.id).toBe(7)
  })
  it('uses the scheduled time when there is one', () => {
    const r = { ...run(1, 'inverter.decide', '2026-10-09T11:30:01Z'), scheduled_at: '2026-10-09T11:29:59Z' }
    expect(new Date(runSlot(r)).toISOString()).toBe('2026-10-09T11:15:00.000Z')
  })
})

describe('rules', () => {
  it('lists the rules in the automation order with the configured thresholds', () => {
    const list = rules(undefined, 0.03)
    expect(list.map((r) => r.id)).toEqual([
      'force_charge',
      'use_bat_import',
      'use_only_grid',
      'charge_export',
      'force_discharge',
      'self_use_pv_export',
      'self_use',
      'self_use_restrict',
      'self_use',
    ])
    expect(list.find((r) => r.id === 'force_charge')?.sets).toContain('18800 W (the import max;')
    expect(list.find((r) => r.id === 'force_charge')?.sets).toContain('battery -20000…20000 W')
    expect(list.find((r) => r.id === 'self_use_pv_export')?.sets).toContain('battery -20000…0 W')
    expect(list.find((r) => r.id === 'self_use_pv_export')?.when).toContain('above 0.03 €/kWh')
  })

  it("follows the plan's P_grid in Force charge when the import max is off", () => {
    const limits = {
      battery_max_w: 20000,
      battery_min_w: -20000,
      grid_import_max_w: 18800,
      export_max_w: 15500,
      force_charge_at_import_max: false,
      force_charge_grid_cap_above_w: 9000,
      force_charge_grid_margin_w: 1000,
      cap_discharge_at_plan: true,
      cap_charge_at_plan: true,
      battery_cap_slack_w: 500,
      battery_full_soc_pct: 90,
    }
    expect(rules(limits, 0.03).find((r) => r.id === 'force_charge')?.sets).toContain(
      '18800 W if P_grid > 9000 W, else P_grid rounded to 100 W + 1000 W',
    )
  })

  it('gives every rule its own key, so only the one that matched is tagged', () => {
    const list = rules(undefined, 0.03)
    expect(list.map((r) => r.key)).toEqual([
      'force_charge',
      'use_bat_import',
      'use_only_grid',
      'charge_export',
      'force_discharge',
      'self_use_pv_export',
      'self_use_keep_pv',
      'self_use_restrict',
      'self_use',
    ])
    expect(new Set(list.map((r) => r.title)).size).toBe(list.length)
    expect(list.filter((r) => r.state === 'Self-use battery or PV').map((r) => r.key)).toEqual([
      'use_bat_import',
      'self_use_keep_pv',
      'self_use',
    ])
    expect(list.map((r) => r.group)).toEqual([
      'import',
      'import',
      'import',
      'export',
      'export',
      'export',
      'export',
      'neutral',
      'neutral',
    ])
    expect(RULE_GROUPS.map((g) => g.group)).toEqual(['import', 'export', 'neutral'])
  })

  it('caps the battery at the plan in the two mixed rules, within the slack', () => {
    const list = rules(undefined, 0.03)
    const discharge = list.find((r) => r.key === 'use_bat_import')?.sets
    expect(discharge).toContain("battery min = −(the plan's discharge + 250 W) rounded up to 100 W, max 20000 W")
    expect(discharge).toContain('the grid the rest; kept while 0–500 W above the plan')
    const charge = list.find((r) => r.key === 'charge_export')?.sets
    expect(charge).toContain("max = the plan's charge + 250 W rounded up to 100 W")
    expect(charge).toContain('At or below 0.03 €/kWh: battery -20000…20000 W, because the feed-in limit is 0 W')
    expect(list.find((r) => r.key === 'self_use_keep_pv')?.when).toContain('Rare: EMHASS plans no export')
  })

  it('says what the mixed rules do with the caps off or without a slack', () => {
    const base = {
      battery_max_w: 20000,
      battery_min_w: -20000,
      grid_import_max_w: 18800,
      export_max_w: 15500,
      force_charge_at_import_max: true,
      force_charge_grid_cap_above_w: 9000,
      force_charge_grid_margin_w: 1000,
      cap_discharge_at_plan: false,
      cap_charge_at_plan: false,
      battery_cap_slack_w: 500,
      battery_full_soc_pct: 90,
    }
    const off = rules(base, 0.03)
    expect(off.find((r) => r.key === 'use_bat_import')?.sets).toBe(
      'grid 0 W, battery -20000…20000 W (the battery covers the whole house)',
    )
    expect(off.find((r) => r.key === 'charge_export')?.sets).toBe(
      'grid 0 W, battery -20000…20000 W (the battery takes all the surplus)',
    )
    expect(deviations(base)).toHaveLength(2)
    const noSlack = rules({ ...base, cap_discharge_at_plan: true, battery_cap_slack_w: 0 }, 0.03)
    expect(noSlack.find((r) => r.key === 'use_bat_import')?.sets).toBe(
      "grid 0 W, battery min = −(the plan's discharge) rounded up to 100 W, max 20000 W: the battery gives what the " +
        'plan says, the grid the rest',
    )
    expect(deviations(undefined)).toHaveLength(4)
  })

  it('says export is never blocked when "No export at or below" is empty', () => {
    expect(rules(undefined, null).find((r) => r.id === 'self_use_pv_export')?.when).toContain('never blocked')
    expect(feedinRules(undefined, null)[0]).toBe(
      '15500 W (the export maximum) in every slot: "No export at or below" is empty',
    )
    expect(feedinRules(undefined, 0.03)[0]).toContain('at or below 0.03 €/kWh')
  })

  it('says the limit is only written when something can reach the grid', () => {
    const [written] = feedinRules(undefined, 0.03).slice(-1)
    expect(written).toContain('Written only when something can reach the grid')
    expect(written).toContain('at or above 90 %')
  })
})

describe('fieldValue', () => {
  it('shows watts and states', () => {
    expect(fieldValue('grid_power_w', 5600.4)).toBe('5600 W')
    expect(fieldValue('state', 'Force charge')).toBe('Force charge')
    expect(fieldValue('feedin_max_w', null)).toBe('—')
  })
})

describe('decideChip', () => {
  it('names decisions made while the automation was not in control', () => {
    expect(decideChip({ outcome: 'noop', summary: "Not in control (x is 'off'); would: 'Force charge' (rule g)" })).toEqual({
      color: 'amber',
      text: 'Not in control',
    })
    expect(decideChip({ outcome: 'noop', summary: 'Nothing to decide: no plan row for this slot' })).toBeNull()
    expect(decideChip({ outcome: 'dry_run', summary: "Would set 'Force charge' (rule g)" })).toBeNull()
  })
})

const FC = "'Force charge' (rule force_charge): grid 5600 W, battery -3000…20000 W, feed-in unchanged"
const SELF = "'Self-use battery or PV' (rule self_use): grid 0 W, battery -20000…20000 W, feed-in unchanged"
const PVX = "'Self-use PV and export excess to grid' (rule self_use_pv_export): grid 0 W, battery -16000…0 W, feed-in 15500 W"

describe('parseDecisionTargets', () => {
  it('reads the settings from every kind of decide summary', () => {
    expect(parseDecisionTargets(`Would set ${FC}`)).toEqual({
      state: 'Force charge',
      rule: 'force_charge',
      grid_power_w: 5600,
      battery_min_w: -3000,
      battery_max_w: 20000,
      feedin_max_w: null,
    })
    expect(parseDecisionTargets(`Set ${PVX}`)?.feedin_max_w).toBe(15500)
    expect(parseDecisionTargets(`Already set: ${PVX}`)?.battery_max_w).toBe(0)
    expect(parseDecisionTargets(`Not in control (x is 'off' (e.g. an mFRR session)); would: ${FC}`)?.state).toBe(
      'Force charge',
    )
    const drift = `Drift: grid power 0 W; set back · Set ${FC} (catch-up after Home Assistant came back)`
    expect(parseDecisionTargets(drift)?.grid_power_w).toBe(5600)
  })

  it('returns null for runs without settings', () => {
    expect(parseDecisionTargets('Nothing to decide: no plan row for this slot')).toBeNull()
    expect(parseDecisionTargets("Set 'Self-use battery or PV' (rule b): grid 0 W")).toBeNull() // before 0.2.11
    expect(parseDecisionTargets(null)).toBeNull()
  })
})

describe('decisionAction', () => {
  it('tells dry run, written, already set and not in control apart', () => {
    expect(decisionAction(`Would set ${FC}`)).toEqual({ kind: 'would' })
    expect(decisionAction(`Set ${FC}`)).toEqual({ kind: 'set' })
    expect(decisionAction(`Already set: ${FC}`)).toEqual({ kind: 'already' })
    expect(decisionAction(`Not in control (x is 'off' (e.g. an mFRR session)); would: ${FC}`)).toEqual({
      kind: 'blocked',
      reason: "x is 'off' (e.g. an mFRR session)",
    })
    expect(decisionAction(`Drift: grid power 0 W; set back · Set ${FC}`)).toEqual({
      kind: 'set',
      drift: 'grid power 0 W',
    })
    expect(decisionAction('The plan is stale (made never); not touching the inverter')).toBeNull()
  })
})

describe('compareDiffs', () => {
  it('reads what the automation set where it differed', () => {
    expect(
      compareDiffs(
        'Differs — state: decided Force charge, automation set Self-use battery or PV, restrict export to grid; ' +
          'grid_power_w: decided 5600, automation set 5000.0; feedin_max_w: decided 0, automation set None',
      ),
    ).toEqual({
      state: 'Self-use battery or PV, restrict export to grid',
      grid_power_w: '5000 W',
      feedin_max_w: '—',
    })
    expect(compareDiffs('The automation did the same')).toEqual({})
  })
})

describe('inverterStrip', () => {
  const at = (hhmm: string) => `2026-10-10T${hhmm}:05Z`
  it('colours each slot by its state and notes what changed since the slot before', () => {
    const decides = [
      run(1, 'inverter.decide', at('00:00'), 'dry_run', `Would set ${SELF}`),
      run(3, 'inverter.decide', at('00:15'), 'dry_run', `Would set ${FC}`),
      run(5, 'inverter.decide', at('00:30'), 'noop', `Not in control (x is 'off'); would: ${SELF}`),
      run(7, 'inverter.decide', at('00:45'), 'dry_run', `Would set ${PVX}`),
      run(9, 'inverter.decide', at('01:00'), 'dry_run', `Would set ${SELF}`),
      run(11, 'inverter.decide', at('01:15'), 'noop', 'Nothing to decide: no plan row for this slot'),
    ]
    const compares = [
      run(2, 'inverter.compare', at('00:00'), 'ok', 'The automation did the same'),
      run(4, 'inverter.compare', at('00:15'), 'mismatch', 'Differs — grid_power_w: decided 5600, automation set 5000.0'),
    ]
    const strip = inverterStrip(mergeBySlot(decides, compares))
    expect(strip.map((s) => s.fill)).toEqual([
      modeTone('Self-use battery or PV').fill,
      'var(--mode-force-charge)',
      NOT_IN_CONTROL_FILL,
      'var(--mode-pv-export)',
      'var(--mode-self-use)',
      NO_SETTINGS_FILL,
    ])
    expect(strip.map((s) => s.label)).toEqual(['Self-use', 'Force charge', 'Not in control', 'PV export', 'Self-use', null])
    expect(strip.map((s) => s.quiet)).toEqual([true, false, false, false, true, false])
    expect(strip.map((s) => s.band)).toEqual([STRIP_BAND.same, STRIP_BAND.differs, null, null, null, null])
    expect(strip.map((s) => s.runId)).toEqual([1, 3, 5, 7, 9, 11])

    const [first, fc, blocked, pvx, self] = strip.map((s) => s.detail!)
    expect(first?.changed).toEqual([])
    expect(fc?.changed).toEqual(['state', 'grid_power_w', 'battery_min_w'])
    expect(fc?.differs).toEqual({ grid_power_w: '5000 W' })
    // compared with the last slot EMHASS Lens was in control of
    expect(blocked?.changed).toEqual(['state', 'grid_power_w', 'battery_min_w'])
    expect(blocked?.action?.kind).toBe('blocked')
    expect(pvx?.changed).toEqual(['state', 'grid_power_w', 'battery_min_w', 'battery_max_w', 'feedin_max_w'])
    expect(self?.feedinBefore).toEqual({ value: 15500, slot: Date.parse('2026-10-10T00:45:00Z') })
  })

  it('dates the feed-in limit from when it last changed', () => {
    const strip = inverterStrip(
      mergeBySlot(
        [
          run(1, 'inverter.decide', at('00:00'), 'dry_run', `Would set ${PVX}`),
          run(2, 'inverter.decide', at('00:15'), 'dry_run', `Would set ${PVX}`),
          run(3, 'inverter.decide', at('00:30'), 'dry_run', `Would set ${SELF}`),
        ],
        [],
      ),
    )
    expect(strip.map((s) => s.detail?.changed.includes('feedin_max_w'))).toEqual([true, false, false])
    expect(strip[2]?.detail?.feedinBefore).toEqual({ value: 15500, slot: Date.parse('2026-10-10T00:00:00Z') })
  })

  it('marks the slots that wrote to the inverter in live', () => {
    const strip = inverterStrip(
      mergeBySlot(
        [
          run(1, 'inverter.decide', at('00:00'), 'ok', `Set ${FC}`),
          run(2, 'inverter.decide', at('00:15'), 'ok', `Already set: ${FC}`),
        ],
        [],
      ),
    )
    expect(strip.map((s) => s.band)).toEqual([STRIP_BAND.wrote, null])
  })
})

describe('inverterLegend', () => {
  it('counts the slots per state, import to export, then the others', () => {
    const strip = inverterStrip(
      mergeBySlot(
        [
          run(1, 'inverter.decide', '2026-10-10T00:00:05Z', 'dry_run', `Would set ${PVX}`),
          run(2, 'inverter.decide', '2026-10-10T00:15:05Z', 'dry_run', `Would set ${FC}`),
          run(3, 'inverter.decide', '2026-10-10T00:30:05Z', 'dry_run', `Would set ${FC}`),
          run(4, 'inverter.decide', '2026-10-10T00:45:05Z', 'noop', `Not in control (x is 'off'); would: ${FC}`),
          run(5, 'inverter.decide', '2026-10-10T01:00:05Z', 'noop', 'Nothing to decide: no plan row'),
        ],
        [],
      ),
    )
    expect(inverterLegend(strip).map((k) => [k.text, k.count])).toEqual([
      ['Force charge', 2],
      ['PV export', 1],
      ['Not in control', 1],
      ['No settings', 1],
    ])
  })
})
