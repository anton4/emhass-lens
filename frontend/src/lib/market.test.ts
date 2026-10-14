import { describe, expect, it } from 'vitest'
import type { MarketCommandSpan, MarketSettings, RunSummary } from '../api/types'
import {
  commandPower,
  decisionRef,
  marketLane,
  marketOverlay,
  marketRows,
  marketFieldValue,
  marketGuards,
  pairMarketCompares,
  parityFeedinText,
  parseReconcileSummary,
  watchdogText,
  type MarketDecision,
} from './market'

function run(id: number, job: string, startedAt: string, summary: string | null = null, outcome = 'ok'): RunSummary {
  return { id, job, trigger: 'event', started_at: startedAt, scheduled_at: null, outcome, summary, pinned: 0 }
}

describe('parseReconcileSummary', () => {
  it('reads commands, ends, ignores and blocks', () => {
    expect(parseReconcileSummary('Would: Kratt sell 5000W')).toEqual({ kind: 'command', text: 'Kratt sell 5000W' })
    expect(parseReconcileSummary("Kratt sell 7000W: set 'Force discharge', grid -7000 W")).toEqual({ kind: 'command', text: 'Kratt sell 7000W' })
    expect(parseReconcileSummary('Qilowatt safeguard: session ended (mode_cleared). source=kratt mode=none soc=55% powerlimit=0W. Control returned to EMHASS. Handed the inverter back to the plan.')).toEqual({
      kind: 'end',
      text: 'session ended (mode cleared)',
    })
    expect(parseReconcileSummary('Would: Qilowatt safeguard: ignored kratt mfrrup with powerlimit 0W.')?.kind).toBe('ignored')
    expect(parseReconcileSummary("Not in control (input_boolean.qilowatt_automation is 'off'); would: Kratt sell 5000W")?.kind).toBe('blocked')
    expect(parseReconcileSummary('No action: kratt none 0 W, session none → none')).toEqual({ kind: 'none', text: 'kratt none 0 W, session none → none' })
    expect(parseReconcileSummary(null)).toBeNull()
  })
})

describe('pairMarketCompares', () => {
  it('pairs comparisons with the decision they name', () => {
    const reconciles = [run(10, 'market.reconcile', '2026-10-09T11:15:05Z'), run(20, 'market.reconcile', '2026-10-09T11:16:05Z')]
    const compares = [run(11, 'market.compare', '2026-10-09T11:15:17Z', 'Decision #10: the automation did the same')]
    expect(pairMarketCompares(reconciles, compares).map((r) => [r.reconcile?.id, r.compare?.id])).toEqual([
      [20, undefined],
      [10, 11],
    ])
    expect(decisionRef('Decision #10: differs — session: expected sell, HA shows none')).toBe(10)
  })
})

describe('marketGuards and values', () => {
  it('names the guards with the configured thresholds', () => {
    const guards = marketGuards(undefined)
    expect(guards).toHaveLength(5)
    expect(guards[0]?.text).toContain('1000 W')
    expect(guards[2]?.text).toContain('180 s')
    expect(guards[3]?.text).toContain('raised to 15500 W at once')
    expect(guards[3]?.text).toContain('at 97 % or more')
    const custom: MarketSettings['thresholds'] = {
      enter_w: 1000,
      exit_w: 400,
      cooldown_s: 180,
      big_change_w: 2500,
      deadband_w: 300,
      deadband_pct: 0.15,
      min_soc: 10,
      sell_full_soc_pct: 99,
      settle_s: 2,
      unavailable_timeout_s: 300,
      low_pv_w: 100,
      buy_cap_w: 18200,
      sell_cap_w: 15500,
      buy_modes: ['buy'],
      sell_modes: ['sell'],
      sources: ['kratt'],
    }
    expect(marketGuards(custom)[3]?.text).toContain('at 99 % or more')
    expect(marketFieldValue('grid_power_w', -5000)).toBe('-5000 W')
    expect(marketFieldValue('session', 'sell')).toBe('sell')
  })
})

describe('parityFeedinText', () => {
  const base = {
    action: 'sell',
    feedin_w: 15500,
    feedin_write: false,
    parity_feedin_w: 1800,
    parity_feedin_write: true,
  } as unknown as MarketDecision
  it('names what the automation would do where it differs', () => {
    expect(parityFeedinText(base)).toBe('The automation would write 1800 W.')
    expect(parityFeedinText({ ...base, feedin_write: true, parity_feedin_write: false, parity_feedin_w: 4200 })).toBe(
      'The automation would leave it for now (its target: 4200 W).',
    )
  })
  it('says nothing where they agree, outside a sell, or for old decisions', () => {
    expect(parityFeedinText({ ...base, parity_feedin_write: false })).toBeNull()
    expect(parityFeedinText({ ...base, feedin_write: true, feedin_w: 1800 })).toBeNull()
    expect(parityFeedinText({ ...base, action: 'buy' })).toBeNull()
    expect(parityFeedinText({ ...base, parity_feedin_w: undefined })).toBeNull()
  })
})

describe('watchdogText', () => {
  const now = new Date('2026-10-10T14:00:00Z')
  const base = {
    enabled: true,
    mode: 'live',
    stale_after_s: 600,
    long_session_s: 10800,
    emhass_off_s: 600,
    checked_at: '2026-10-10T13:59:40Z',
    findings: [],
    last_action: null,
  }

  it('is off when turned off or while market control is', () => {
    expect(watchdogText(null).text).toBe('Off')
    expect(watchdogText({ ...base, enabled: false }).detail).toBe('Turned off under Settings → Qilowatt market control.')
    expect(watchdogText({ ...base, mode: 'off' }).color).toBe('neutral')
  })

  it('says what it watches for, and in Shadow that it only records', () => {
    expect(watchdogText(base, now, 'Europe/Tallinn')).toEqual({
      color: 'green',
      text: 'Every minute',
      detail: 'last check 16:59:40 · clears a session after 10 min without a source, warns after 3 h',
    })
    const shadow = watchdogText({ ...base, mode: 'shadow', checked_at: null }, now, 'Europe/Tallinn')
    expect(shadow.detail).toBe('records only, warns after 3 h')
    const acted = watchdogText(
      { ...base, last_action: { at: '2026-10-10T13:20:00Z', run_id: 7, outcome: 'ok', summary: 'Reported: x' } },
      now,
      'Europe/Tallinn',
    )
    expect(acted.detail?.endsWith(' · last: Reported: x (16:20:00)')).toBe(true)
  })

  it('shows the worst finding first', () => {
    const findings = [
      { kind: 'long_session', severity: 'warning', direction: 'sell', since: null, age_s: 11000, episode: 'l', message: 'sell session from kratt has been open for 3.1 h' },
      { kind: 'stale', severity: 'error', direction: 'sell', since: null, age_s: 700, episode: 's', message: 'sell session: qw_source has been "none" for 11 min' },
    ]
    expect(watchdogText({ ...base, findings }, now)).toEqual({
      color: 'red',
      text: 'Session stuck',
      detail: 'Sell session: qw_source has been "none" for 11 min',
    })
    expect(watchdogText({ ...base, findings: findings.slice(0, 1) }, now).color).toBe('amber')
  })
})

describe('the commands on the Power chart', () => {
  const sell: MarketCommandSpan = {
    start: '2026-10-14T05:45:12.000+00:00',
    end: '2026-10-14T06:04:30.000+00:00',
    direction: 'sell',
    source: 'kratt',
    mode: 'mfrrup',
    power_w: 9400,
    open: false,
  }
  const buy: MarketCommandSpan = { ...sell, start: '2026-10-14T06:58:00Z', end: '2026-10-14T07:30:00Z', direction: 'buy', mode: 'mfrrdown', power_w: 5000, open: true }
  const s = (iso: string) => Date.parse(iso) / 1000

  it('draws a sell below zero and a buy above, at their own times', () => {
    expect(commandPower(sell)).toBe(-9400)
    expect(commandPower(buy)).toBe(5000)
    expect(marketOverlay([sell, buy]).spans).toEqual([
      { from: s(sell.start), to: s(sell.end), value: -9400 },
      { from: s(buy.start), to: s(buy.end), value: 5000 },
    ])
    // a command still on runs on to now
    expect(marketOverlay([buy], s('2026-10-14T07:31:00Z')).spans[0]?.to).toBe(s('2026-10-14T07:31:00Z'))
    expect(marketOverlay([sell], s('2026-10-14T07:31:00Z')).spans[0]?.to).toBe(s(sell.end))
    expect(marketLane([sell]).spans).toEqual([
      { from: s(sell.start), to: s(sell.end), color: '--line-green', text: 'sell 9.40 kW · kratt' },
    ])
  })

  it('lists the commands in the slot under the cursor', () => {
    const tz = 'Europe/Tallinn'
    expect(marketRows([sell, buy], s('2026-10-14T05:30:00Z'), tz)).toEqual([])
    expect(marketRows([sell, buy], s('2026-10-14T06:00:00Z'), tz)).toEqual([
      { name: 'Market sell', value: '9.40 kW · kratt · 08:45:12–09:04:30', color: '--line-green' },
    ])
    expect(marketRows([sell, buy], s('2026-10-14T07:15:00Z'), tz)[0]?.value).toBe('5.00 kW · kratt · 09:58:00–now')
  })
})
