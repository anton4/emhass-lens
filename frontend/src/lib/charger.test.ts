import { describe, expect, it } from 'vitest'
import type { PlanResponse, RunSummary } from '../api/types'
import {
  chargerAhead,
  chargerFacts,
  chargerFieldValue,
  chargerMark,
  chargerRules,
  chargerTicks,
  decisionRef,
  pairCompares,
  parseChargerSummary,
} from './charger'
import { NO_SETTINGS_FILL, NO_SETTINGS_INK, NOT_IN_CONTROL_FILL } from './inverter'

function run(id: number, job: string, startedAt: string, summary: string | null = null, outcome = 'ok'): RunSummary {
  return { id, job, trigger: 'manual', started_at: startedAt, scheduled_at: null, outcome, summary, pinned: 0 }
}

describe('chargerMark', () => {
  const EV = '· mode EMHASS'
  it('names a decision by what the charger was doing, filled by its mode', () => {
    expect(chargerMark(`Would 'EMHASS: start charging' (emhass_start): press start, limit 8 A ${EV}, plugged in, was 0 A, plan 5.5 kW`)).toEqual({
      label: 'charging · plan',
      key: 'EMHASS: charging',
      fill: 'var(--q-ev)',
      ink: 'var(--on-q-ev)',
      wrote: false,
      would: true,
      title: 'EMHASS: start charging',
      amount: 5500,
    })
    expect(chargerMark("Did 'Excess solar: adjust the current' (solar_adjust): limit 13 A · was 10 A")).toMatchObject({
      label: 'charging · excess solar',
      key: 'Excess solar: charging',
      fill: 'var(--q-pv)',
      wrote: true,
      would: false,
      amount: null,
    })
    expect(chargerMark("Would 'EMHASS: pause charging' (emhass_pause): press pause")).toMatchObject({
      label: 'paused · plan',
      fill: expect.stringContaining('--q-ev') as string,
      ink: 'var(--ink)',
    })
    expect(chargerMark("Did 'Target SoC reached: stop charging' (soc_limit): press stop, limit 0 A")?.label).toBe(
      'target SoC reached',
    )
  })

  it('takes the charging state a decision with nothing to do saw', () => {
    const none = (why: string, facts: string) => chargerMark(`Nothing to do: ${why} · ${facts}`)
    expect(none('already charging at the planned 16 A (11040 W)', 'mode EMHASS, charging, was 16 A, plan 11.0 kW')).toMatchObject({
      label: 'charging · plan',
      amount: 11000,
      would: false,
    })
    expect(none('already charging at 11 A from excess solar', 'mode Excess Solar, charging, was 11 A')?.label).toBe(
      'charging · excess solar',
    )
    expect(none('plugged in (state 1), the plan asks 0 W', 'mode EMHASS, plugged in, was 0 A, plan 0.0 kW')).toMatchObject({
      label: 'plugged in · waiting',
      key: 'Plugged in',
      amount: null,
    })
    expect(none("the car's SoC 80 % is at the target 80 %", 'mode EMHASS, plugged in, was 0 A')?.label).toBe(
      'plugged in · done',
    )
    expect(none("the car isn't plugged in (state 0)", 'mode EMHASS, unplugged, was 0 A')).toMatchObject({
      label: 'unplugged',
      key: 'Unplugged',
      fill: 'var(--plug-unplugged)',
      ink: null, // hatched: a chip
    })
    // before 0.5.3 the facts didn't say
    expect(chargerMark('Nothing to do: charge mode is Manual')).toMatchObject({
      label: 'nothing to do',
      fill: NO_SETTINGS_FILL,
      ink: NO_SETTINGS_INK,
    })
  })

  it('marks a decision set back by the drift check as written, and one not in control hatched', () => {
    const drift = "Drift: current 6 A, expected 8 A; set back · Did 'EMHASS: adjust the current' (emhass_adjust): limit 8 A"
    expect(chargerMark(drift)).toMatchObject({ key: 'EMHASS: charging', wrote: true })
    expect(chargerMark("Not in control (charge mode is Manual); would: 'EMHASS: start charging' (emhass_start): press start")).toEqual({
      label: 'not in control',
      key: 'Not in control',
      fill: NOT_IN_CONTROL_FILL,
      ink: null,
      wrote: false,
      would: false,
      title: 'Not in control; would: EMHASS: start charging',
      amount: null,
    })
    expect(chargerMark('Not connected to Home Assistant')).toBeNull()
  })
})

describe('chargerFacts', () => {
  it('reads the mode, the state and the plan from the facts since 0.5.3', () => {
    expect(chargerFacts("Did 'EMHASS: start charging' (emhass_start): press start · mode EMHASS, plugged in, was 0 A, plan 5.5 kW")).toEqual({
      mode: 'EMHASS',
      state: 'plugged in',
      planW: 5500,
    })
    expect(chargerFacts('Nothing to do: x · mode unknown, state 3, was 0 A')).toEqual({ mode: null, state: 'state 3', planW: null })
    expect(chargerFacts("Would 'EMHASS: start charging' (emhass_start): press start · was 0 A, plan 5.5 kW")).toEqual({
      mode: null,
      state: null,
      planW: 5500,
    })
  })
})

describe('chargerTicks', () => {
  it('ticks the writes, what a dry run would write, the holds and where the car came or went', () => {
    const at = (m: number) => 1_760_000_000 + m * 60
    const ticks = chargerTicks([
      { t: at(0), summary: 'Nothing to do: x · mode EMHASS, unplugged, was 0 A' },
      { t: at(15), summary: 'Nothing to do: x · mode EMHASS, unplugged, was 0 A' },
      { t: at(30), summary: 'Nothing to do: x · mode EMHASS, plugged in, was 0 A, plan 0.0 kW' }, // plugged in
      { t: at(45), summary: "Would 'EMHASS: start charging' (emhass_start): press start · mode EMHASS, plugged in, was 0 A, plan 5.5 kW" },
      { t: at(60), summary: "Did 'EMHASS: pause charging' (emhass_pause): limit 0 A · mode EMHASS, charging, was 8 A, plan 0.0 kW" },
      { t: at(75), summary: "Not in control (charge mode is Manual); would: 'EMHASS: start charging' (emhass_start): press start" },
      { t: at(90), summary: 'Nothing to do: x · mode Manual, plugged in, was 0 A' }, // was charging at 60
    ])
    expect(ticks.map((k) => [(k.t - at(0)) / 60, k.kind])).toEqual([
      [30, 'noop'],
      [45, 'would'],
      [60, 'wrote'],
      [75, 'held'],
      [90, 'noop'],
    ])
  })
})

describe('chargerAhead', () => {
  const tz = 'Europe/Tallinn'
  const at = (iso: string) => Date.parse(iso) / 1000
  const plan = (rows: [string, number][]) =>
    ({
      current: { run_id: 4554, rows: rows.map(([timestamp, P_deferrable0]) => ({ timestamp, P_deferrable0 })) },
    }) as unknown as PlanResponse

  it('draws the planned charging and names the next one between', () => {
    // now Fri 16 Oct 14:00 in Tallinn; the plan charges 15:00–15:30 and Sat 03:00–03:30
    const rows: [string, number][] = [
      ['2026-10-16T10:45:00Z', 0], // over before now
      ['2026-10-16T11:00:00Z', 0],
      ['2026-10-16T11:15:00Z', 0],
      ['2026-10-16T11:30:00Z', 0],
      ['2026-10-16T11:45:00Z', 0],
      ['2026-10-16T12:00:00Z', 11000],
      ['2026-10-16T12:15:00Z', 10500],
      ['2026-10-16T12:30:00Z', 0],
      ['2026-10-17T00:00:00Z', 11000],
      ['2026-10-17T00:15:00Z', 11000],
      ['2026-10-17T00:30:00Z', 0],
    ]
    const ahead = chargerAhead(plan(rows), at('2026-10-16T11:00:00Z'), tz)
    expect(ahead.map((a) => [a.label, a.t, a.span, a.amount ?? null])).toEqual([
      ['next plan: 15:00–15:30', at('2026-10-16T11:00:00Z'), 3600, null],
      ['charging · plan', at('2026-10-16T12:00:00Z'), 1800, 11000],
      ['next plan: Sat 03:00–03:30', at('2026-10-16T12:30:00Z'), 900, null],
      ['charging · plan', at('2026-10-17T00:00:00Z'), 1800, 11000],
      ['nothing planned', at('2026-10-17T00:30:00Z'), 900, null],
    ])
    expect(ahead[1]?.detail).toMatchObject({ title: 'Charging planned', planned: 'EMHASS plans up to 11.0 kW for the car (the plan of run 4554).' })
  })

  it('names the next charge on another day with its weekday, and leaves out a plan without an EV load', () => {
    const rows: [string, number][] = [
      ['2026-10-16T11:00:00Z', 0],
      ['2026-10-17T00:00:00Z', 11000],
    ]
    expect(chargerAhead(plan(rows), at('2026-10-16T11:00:00Z'), tz)[0]?.label).toBe('next plan: Sat 03:00–03:15')
    expect(chargerAhead({ current: { rows: [{ timestamp: '2026-10-16T11:00:00Z' }] } } as unknown as PlanResponse, 0, tz)).toEqual([])
    expect(chargerAhead(undefined, 0, tz)).toEqual([])
  })
})

describe('parseChargerSummary', () => {
  it('reads the rule from dry-run and live summaries', () => {
    expect(parseChargerSummary("Would 'EMHASS: start charging' (emhass_start): press start, limit 8 A")).toEqual({
      rule: 'emhass_start',
      label: 'EMHASS: start charging',
      action: 'press start, limit 8 A',
      facts: null,
    })
    expect(parseChargerSummary("Did 'Target SoC reached: stop charging' (soc_limit): press stop, limit 0 A")).toEqual({
      rule: 'soc_limit',
      label: 'Target SoC reached: stop charging',
      action: 'press stop, limit 0 A',
      facts: null,
    })
    expect(parseChargerSummary('Nothing to do: charge mode is Manual')).toEqual({
      rule: 'none',
      label: 'Nothing to do',
      action: 'charge mode is Manual',
      facts: null,
    })
    expect(parseChargerSummary('Not connected to Home Assistant')).toBeNull()
  })

  it('reads the numbers behind a decision', () => {
    const facts = 'was 10 A, PV 10.5 kW (actual), house load 8.4 kW (charger 6.9 kW of it), surplus 9.0 kW'
    expect(parseChargerSummary(`Would 'Excess solar: adjust the current' (solar_adjust): limit 13 A · ${facts}`)).toEqual({
      rule: 'solar_adjust',
      label: 'Excess solar: adjust the current',
      action: 'limit 13 A',
      facts,
    })
    expect(
      parseChargerSummary("Would 'EMHASS: start charging' (emhass_start): press start, limit 8 A (control is off) · was 0 A, plan 5.5 kW"),
    ).toMatchObject({ action: 'press start, limit 8 A', facts: 'was 0 A, plan 5.5 kW' })
    expect(
      parseChargerSummary("Did 'EMHASS: start charging' (emhass_start): press start, limit 8 A · was 0 A, plan 5.5 kW; the notification failed"),
    ).toMatchObject({ facts: 'was 0 A, plan 5.5 kW' })
    expect(parseChargerSummary('Nothing to do: the car is unplugged · was 0 A')).toMatchObject({
      action: 'the car is unplugged',
      facts: 'was 0 A',
    })
    // since 0.5.3 the facts start with the charge mode and the charging state
    expect(
      parseChargerSummary("Did 'EMHASS: start charging' (emhass_start): press start, limit 8 A · mode EMHASS, plugged in, was 0 A, plan 5.5 kW"),
    ).toMatchObject({ rule: 'emhass_start', facts: 'mode EMHASS, plugged in, was 0 A, plan 5.5 kW' })
  })
})

describe('pairCompares', () => {
  it('pairs each comparison with the decision it names, newest first, and keeps loose comparisons', () => {
    const decides = [run(10, 'charger.decide', '2026-10-09T11:15:05Z'), run(20, 'charger.decide', '2026-10-09T11:16:05Z')]
    const compares = [
      run(11, 'charger.compare', '2026-10-09T11:15:15Z', 'Decision #10: the automation did the same'),
      run(30, 'charger.compare', '2026-10-09T11:17:00Z', 'The automation set the current limit from 8 A to 0 A', 'mismatch'),
    ]
    const rows = pairCompares(decides, compares)
    expect(rows.map((r) => [r.decide?.id, r.compare?.id])).toEqual([
      [undefined, 30],
      [20, undefined],
      [10, 11],
    ])
    expect(decisionRef('Decision #10: differs — current_limit_a: decided 8, automation set 6.0')).toBe(10)
  })
})

describe('chargerRules and values', () => {
  it('lists the seven branches with the configured thresholds', () => {
    const list = chargerRules(undefined)
    expect(list.map((r) => r.id)).toEqual([
      'soc_limit',
      'emhass_start',
      'emhass_adjust',
      'emhass_pause',
      'solar_start',
      'solar_adjust',
      'solar_pause',
    ])
    expect(list.find((r) => r.id === 'soc_limit')?.when).toContain('5 min')
  })
  it('formats amps, percent and charger states', () => {
    expect(chargerFieldValue('current_limit_a', 8)).toBe('8 A')
    expect(chargerFieldValue('target_soc', 100)).toBe('100 %')
    expect(chargerFieldValue('state_raw', 4)).toBe('charging (4)')
    expect(chargerFieldValue('state_raw', null)).toBe('—')
  })
})
