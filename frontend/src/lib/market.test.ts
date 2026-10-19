import { describe, expect, it } from 'vitest'
import type { GridDetail, MarketCommandSpan, MarketSettings, RunSummary } from '../api/types'
import {
  commandPower,
  commandSessions,
  decisionRef,
  deliveredW,
  marketBlock,
  marketLead,
  commandTarget,
  marketProduct,
  sessionProduct,
  marketLane,
  marketMark,
  marketOverlay,
  marketFieldValue,
  marketGuards,
  pairMarketCompares,
  parityFeedinText,
  parseReconcileSummary,
  sessionBands,
  sessionWindow,
  shortfallGap,
  shortfalls,
  watchdogText,
  type MarketDecision,
} from './market'
import { marketFill, NO_SETTINGS_FILL, NO_SETTINGS_INK, NOT_IN_CONTROL_FILL } from './inverter'

function run(id: number, job: string, startedAt: string, summary: string | null = null, outcome = 'ok'): RunSummary {
  return { id, job, trigger: 'event', started_at: startedAt, scheduled_at: null, outcome, summary, pinned: 0 }
}

describe('marketMark', () => {
  it('fills a session like the Inverter strip, striped in the state it sets, and says whether it wrote', () => {
    const live = marketMark("Kratt sell 7000W: set 'Force discharge', grid -7000 W, battery -20000…20000 W; feed-in 7000 W")
    // striped: the name goes on a chip, so no ink
    expect(live).toEqual({ label: 'Kratt sell 7000W', key: 'Market sell', fill: marketFill('sell'), ink: null, wrote: true })
    expect(marketMark('Kratt buy 5000W: feed-in 0 W')).toMatchObject({ key: 'Market buy', fill: marketFill('buy'), wrote: true })
    expect(marketMark('Kratt sell 7000W: registers unchanged')?.wrote).toBe(false)
    expect(marketMark('Would: Kratt sell 5000W')).toMatchObject({ key: 'Market sell', wrote: false })
  })

  it('names and fills the decisions without a session', () => {
    expect(marketMark('No action: no command')).toMatchObject({
      label: 'no action',
      fill: NO_SETTINGS_FILL,
      ink: NO_SETTINGS_INK,
    })
    expect(marketMark("Not in control (input_boolean.qilowatt_automation is 'off'); would: Kratt sell 5000W")).toMatchObject({
      label: 'not in control',
      fill: NOT_IN_CONTROL_FILL,
      wrote: false,
    })
    expect(marketMark('Qilowatt safeguard: session ended (mode_cleared). Handed the inverter back to the plan.')).toMatchObject({
      label: 'session end',
      key: 'Session end',
    })
    expect(marketMark('Would: Qilowatt safeguard: ignored kratt mfrrup with powerlimit 0W.')?.key).toBe('Ignored')
    expect(marketMark('Something new')).toMatchObject({ label: null, key: 'Other' })
    expect(marketMark(null)).toBeNull()
  })
})

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
    expect(guards[1]?.text).toContain('a gap of more than 300 W that holds for 180 s is written anyway')
    expect(guards[2]?.text).toContain('180 s')
    expect(guards[3]?.text).toContain('raised to 15500 W at once')
    expect(guards[3]?.text).toContain('at 97 % or more')
    const custom: MarketSettings['thresholds'] = {
      baseline_s: 60,
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
  const tz = 'Europe/Tallinn'
  const s = (iso: string) => Date.parse(iso) / 1000
  const span = (start: string, end: string, power_w: number, measured_w?: number): MarketCommandSpan => ({
    start,
    end,
    direction: 'sell',
    source: 'kratt',
    mode: 'mfrrup',
    power_w,
    open: false,
    measured_w,
    measured_coverage: measured_w === undefined ? undefined : 1,
  })
  // a sell session of three commands (08:45:10–08:50:10 in Tallinn), and a buy still on
  const a = span('2026-10-14T05:45:10Z', '2026-10-14T05:47:00Z', 5200, -5150)
  const b = span('2026-10-14T05:47:00Z', '2026-10-14T05:49:00Z', 9000, -7000)
  const c = span('2026-10-14T05:49:00Z', '2026-10-14T05:50:10Z', 6000, -6000)
  const buy: MarketCommandSpan = { ...span('2026-10-14T06:58:00Z', '2026-10-14T07:30:00Z', 5000), direction: 'buy', mode: 'mfrrdown', open: true }
  const NOW = s('2026-10-14T07:31:00Z')
  const sessions = commandSessions([buy, c, a, b], NOW)
  // the grid every 10 s: a 20 s dip under the first command (too short to count), then 90 s under the second
  const point = (t: string, w: number | null) => ({ t: `2026-10-14T${t}Z`, w })
  const detail: GridDetail = {
    entity: 'sensor.grid',
    start: '2026-10-14T05:45:10Z',
    end: '2026-10-14T05:50:10Z',
    step_s: 10,
    points: [
      point('05:45:10', -5150),
      point('05:46:00', -4000),
      point('05:46:20', -5200),
      point('05:47:00', -8950),
      point('05:47:30', -7000),
      point('05:48:40', -8000),
      point('05:49:00', -6000),
    ],
    error: null,
  }

  it('draws the commanded power as one solid line, a sell below zero and a buy above, at their own times', () => {
    expect(commandPower(a)).toBe(-5200)
    expect(commandPower(buy)).toBe(5000)
    const overlay = marketOverlay([a, buy], NOW)
    expect(overlay).toMatchObject({ color: '--q-market', base: 'none', dash: [6, 4], dot: true })
    expect(overlay.spans).toEqual([
      { from: s(a.start), to: s(a.end), value: -5200 },
      { from: s(buy.start), to: NOW, value: 5000 }, // still on: runs on to now
    ])
  })

  it('leaves the y-axis to the measured lines, a command past it labelled with its direction and power', () => {
    const overlay = marketOverlay([a, buy], NOW)
    expect(overlay.fit).toBe(false)
    expect(overlay.offScale?.(15500)).toBe('↓ 15.5 kW') // a buy: down
    expect(overlay.offScale?.(-12900)).toBe('↑ 12.9 kW') // a sell: up
  })

  it('says what the grid delivered over a command, counted in its direction', () => {
    expect(deliveredW(b)).toBe(7000)
    expect(deliveredW({ ...buy, measured_w: 4800 })).toBe(4800)
    expect(deliveredW(buy)).toBeNull()
  })

  it('groups back-to-back commands in one direction into a session', () => {
    expect(sessions.map((x) => [x.direction, x.spans.length, x.from, x.to, x.open])).toEqual([
      ['sell', 3, s(a.start), s(c.end), false],
      ['buy', 1, s(buy.start), NOW, true],
    ])
    const sell = sessions[0]!
    expect([sell.minW, sell.maxW]).toEqual([5200, 9000])
    // 1826.5 of 2072 kWs asked: each command's measured mean over its time, never more than it asked
    expect(sell.delivered).toBeCloseTo(1826500 / 2072000, 6)
    expect(sessions[1]!.delivered).toBeNull()
    // a gap or a turn starts another
    const later = span('2026-10-14T05:50:20Z', '2026-10-14T05:51:00Z', 4000)
    const turn = { ...span('2026-10-14T05:50:10Z', '2026-10-14T05:50:20Z', 4000), direction: 'buy' }
    expect(commandSessions([a, b, c, later]).length).toBe(2)
    expect(commandSessions([a, b, c, turn]).map((x) => x.direction)).toEqual(['sell', 'buy'])
  })

  it('finds where the grid fell short of a command for a minute or more', () => {
    const runs = shortfalls([a, b, c], detail)
    expect(runs).toEqual([
      {
        from: s('2026-10-14T05:47:30Z'),
        to: s('2026-10-14T05:49:00Z'),
        worstW: 2000,
        pieces: [
          { from: s('2026-10-14T05:47:30Z'), to: s('2026-10-14T05:48:40Z'), commanded: -9000, measured: -7000 },
          { from: s('2026-10-14T05:48:40Z'), to: s('2026-10-14T05:49:00Z'), commanded: -9000, measured: -8000 },
        ],
      },
    ])
    expect(shortfallGap(runs).spans).toEqual([
      { from: s('2026-10-14T05:47:30Z'), to: s('2026-10-14T05:48:40Z'), a: -9000, b: -7000 },
      { from: s('2026-10-14T05:48:40Z'), to: s('2026-10-14T05:49:00Z'), a: -9000, b: -8000 },
    ])
    // no value is never short; no detail, nothing to judge
    expect(shortfalls([b], { ...detail, points: detail.points.map((p) => ({ ...p, w: null })) })).toEqual([])
    expect(shortfalls([b], undefined)).toEqual([])
  })

  it('flags each session with its direction and power, and more while the pointer is in it', () => {
    expect(sessionBands(sessions, tz)).toEqual([
      {
        id: a.start,
        from: s(a.start),
        to: s(c.end),
        group: 'sell',
        color: '--q-sell',
        ink: '--q-sell-ink',
        label: '↑ SELL · mFRR · 5.2–9.0 kW', // a sell regulates up, a buy down
        detail: '↑ SELL · kratt · mfrrup · 08:45–08:50 · 88 % delivered',
        short: '↑',
        hatch: false,
      },
      {
        id: buy.start,
        from: s(buy.start),
        to: NOW,
        group: 'buy',
        color: '--q-buy',
        ink: '--q-buy-ink',
        label: '↓ BUY · mFRR · 5.0 kW',
        detail: '↓ BUY · kratt · mfrrdown · 09:58–now',
        short: '↓',
        hatch: false,
      },
    ])
  })

  it('draws a bar per session in the lane, its shortfalls hatched across it', () => {
    const lane = marketLane(sessions, shortfalls([a, b, c], detail))
    expect(lane.spans[0]).toEqual({
      from: s(a.start),
      to: s(c.end),
      color: '--q-sell',
      ink: '--q-sell-ink',
      text: '88 %',
      long: 'sell · mFRR · 3 commands · 88 % delivered · shortfall 2 min',
      marks: [{ from: s('2026-10-14T05:47:30Z'), to: s('2026-10-14T05:49:00Z'), color: '--q-shortfall' }],
      id: a.start,
    })
    expect(lane.spans[1]).toMatchObject({ text: undefined, long: 'buy · mFRR · 1 command', marks: [] })
  })

  it('zooms to a session with a little time either side, in whole quarter-hours', () => {
    expect(sessionWindow(sessions[0]!)).toEqual([s('2026-10-14T05:30:00Z'), s('2026-10-14T06:00:00Z')])
  })

  it('tells the popup what the grid delivered of the command at the pointer, and the session', () => {
    const runs = shortfalls([a, b, c], detail)
    const at = (iso: string, d: GridDetail | null = detail) =>
      marketBlock({ spans: [a, b, c, buy], sessions, runs, detail: d ?? undefined, time: s(iso), nowS: NOW, timeZone: tz })
    expect(at('2026-10-14T05:48:00Z')).toEqual({
      title: '↑ SELL · mFRR',
      sub: 'kratt · mfrrup',
      tone: 'sell',
      text: '7.00 of 9.00 kW delivered (78 %)',
      meter: 7 / 9,
      rows: [{ name: 'Shortfall', value: '2.00 kW', color: '--q-shortfall', swatch: 'hatch', alert: true }],
      foot: ['Session 08:45–08:50 · 3 commands', '5.2–9.0 kW · 88 % delivered'],
    })
    // past the shortfall: no shortfall row
    expect(at('2026-10-14T05:46:10Z')?.rows).toEqual([])
    // without the grid detail: what the grid delivered over the command
    expect(at('2026-10-14T05:48:00Z', null)).toMatchObject({
      text: '7.00 of 9.00 kW delivered (78 %, mean over the command)',
      rows: [],
    })
    expect(at('2026-10-14T07:00:00Z')).toMatchObject({
      title: '↓ BUY · mFRR',
      tone: 'buy',
      text: '5.00 kW requested',
      meter: undefined,
      foot: ['Session 09:58–now · 1 command', '5.0 kW'],
    })
    expect(at('2026-10-14T06:30:00Z')).toBeNull()
  })

  it('puts the command right under the grid reading', () => {
    expect(marketLead({ spans: [a, b, c, buy], time: s('2026-10-14T05:48:00Z'), nowS: NOW, timeZone: tz })).toEqual([
      { name: 'commanded, since 08:47:00', value: '−9.00 kW', color: '--q-market', swatch: 'dash' },
    ])
    expect(marketLead({ spans: [a], time: s('2026-10-14T06:30:00Z'), nowS: NOW, timeZone: tz })).toEqual([])
  })

})

describe('marketProduct', () => {
  it('reads mFRR and aFRR from the mode, nothing from a plain buy or sell', () => {
    expect(marketProduct('mfrrup')).toBe('mFRR')
    expect(marketProduct('MFRRDOWN')).toBe('mFRR')
    expect(marketProduct('frrup')).toBe('aFRR')
    expect(marketProduct('afrrdown')).toBe('aFRR')
    expect(marketProduct('sell')).toBeNull()
  })

  it('names the product of a session only when all its commands share it', () => {
    const span = (mode: string) => ({ mode }) as MarketCommandSpan
    expect(sessionProduct({ spans: [span('frrup'), span('frrup')] })).toBe('aFRR')
    expect(sessionProduct({ spans: [span('frrup'), span('mfrrup')] })).toBeNull()
  })
})

describe('the baseline', () => {
  const s = (iso: string) => Date.parse(iso) / 1000
  const tz = 'Europe/Tallinn'
  const base = (over: Partial<MarketCommandSpan>): MarketCommandSpan =>
    ({
      start: '2026-10-14T05:45:00Z',
      end: '2026-10-14T05:50:00Z',
      direction: 'sell',
      source: 'kratt',
      mode: 'mfrrup',
      power_w: 9000,
      open: false,
      ...over,
    }) as MarketCommandSpan

  it('puts the target at the baseline less a sell, plus a buy', () => {
    expect(commandTarget(base({ baseline_w: 500 }))).toBe(-8500)
    expect(commandTarget(base({ direction: 'buy', baseline_w: 500 }))).toBe(9500)
    expect(commandTarget(base({}))).toBe(-9000)
  })

  it('counts what was delivered from the baseline', () => {
    // 8.5 kW exported from 500 W imported: 9 kW of sell delivered
    expect(deliveredW(base({ baseline_w: 500, measured_w: -8500 }))).toBe(9000)
    expect(deliveredW(base({ direction: 'buy', baseline_w: 500, measured_w: 9500 }))).toBe(9000)
    expect(deliveredW(base({ measured_w: -8500 }))).toBe(8500)
  })

  it('puts the target and the baseline under the grid in the popup', () => {
    const span = base({ baseline_w: 500 })
    expect(marketLead({ spans: [span], time: s('2026-10-14T05:46:00Z'), timeZone: tz })).toEqual([
      { name: 'commanded target, since 08:45:00', value: '−8.50 kW', color: '--q-market', swatch: 'dash' },
      { name: 'baseline, before the session', value: '+500 W', color: '--ink-faint', swatch: 'none' },
    ])
  })

  it('judges a shortfall from the baseline', () => {
    const span = base({ baseline_w: 500 })
    const detail: GridDetail = {
      entity: 'sensor.grid',
      start: '2026-10-14T05:45:00Z',
      end: '2026-10-14T05:50:00Z',
      step_s: null,
      points: [{ t: '2026-10-14T05:45:00Z', w: -8400 }],
      error: null,
    }
    // −8.4 kW from +500 W is 8.9 kW delivered: within 10 % of 9 kW, no shortfall
    expect(shortfalls([span], detail)).toEqual([])
    // from 1.5 kW exported before the session the same reading is only 6.9 kW delivered: short
    expect(shortfalls([{ ...span, baseline_w: -1500 }], detail)).toHaveLength(1)
  })
})
