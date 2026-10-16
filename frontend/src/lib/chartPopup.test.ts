import { describe, expect, it } from 'vitest'
import { momentLabel, nearestRow, placePopup, popupRows, readoutText, slotRange, type PopupSeries } from './chartPopup'
import { formatPower, formatSignedPower } from './units'

const charging = (w: number) => (w > 0 ? 'charging' : w < 0 ? 'discharging' : 'idle')

// three slots: measured past (with the plan at the time), then the plan; the battery drawn with charging up
const SERIES: PopupSeries[] = [
  { label: 'Battery (+ charge)', popupLabel: 'Battery', color: '--q-batt', values: [2910, -11890, 3000], format: formatSignedPower, describe: charging },
  { label: 'Battery (+ charge), planned at the time', color: '--q-batt', dash: [4, 4], then: true, values: [3000, -12000, null], format: formatSignedPower },
  { label: 'PV', color: '--q-pv', values: [11530, 0, 11800], format: formatPower },
  { label: 'PV, planned at the time', color: '--q-pv', dash: [4, 4], then: true, values: [11800, null, null], format: formatPower },
  { label: 'Deferrable load', color: '--q-ev', values: [null, null, 4100], format: formatPower },
  { label: 'Deferrable load, planned at the time', color: '--q-ev', dash: [4, 4], then: true, values: [4100, null, null], format: formatPower },
]

describe('the popup rows', () => {
  it('folds the plan at the time into its row, with signs and direction words', () => {
    const { rows, hasThen } = popupRows(SERIES, 0)
    expect(hasThen).toBe(true)
    expect(rows.map((r) => [r.name, r.value, r.describe, r.then])).toEqual([
      ['Battery', '+2.91 kW', 'charging', '+3.00 kW'],
      ['PV', '11.53 kW', '', '11.80 kW'],
      ['Deferrable load', '—', '', '4.10 kW'], // no measurement, only the plan then
    ])
    expect(rows[0]).toMatchObject({ series: 0, color: '--q-batt', dashed: false })
  })

  it('has no "planned then" column in the plan, and leaves out lines with nothing there', () => {
    const { rows, hasThen } = popupRows(SERIES, 2)
    expect(hasThen).toBe(false)
    expect(rows.map((r) => [r.name, r.value, r.then])).toEqual([
      ['Battery', '+3.00 kW', null],
      ['PV', '11.80 kW', null],
      ['Deferrable load', '4.10 kW', null],
    ])
    expect(popupRows(SERIES, 1).rows.map((r) => r.value)).toEqual(['−11.89 kW', '0 W'])
  })

  it("shows the grid at the pointer's moment, with the slot's mean beside it", () => {
    const at = (time: number) => (time < 100 ? -9310 : null) // measured up to now (100)
    const grid: PopupSeries[] = [
      { label: 'Grid', color: '--q-grid', values: [null, null, 2100], readout: [-7900, -8000, 2100], moment: at, format: formatSignedPower },
      { label: 'Grid, planned at the time', color: '--q-grid', dash: [4, 4], then: true, values: [-8000, null, null], format: formatSignedPower },
    ]
    expect(popupRows(grid, 0, 50).rows.map((r) => [r.name, r.value, r.slot, r.range, r.then])).toEqual([
      ['Grid', '−9.31 kW', '−7.90 kW', null, '−8.00 kW'],
    ])
    // right of now there is no moment: the plan's slot, nothing beside it
    expect(popupRows(grid, 2, 150).rows.map((r) => [r.value, r.slot])).toEqual([['+2.10 kW', null]])
    expect(popupRows(grid, 0).rows[0]?.slot).toBeNull()
    // a long window's bucket: its lowest and highest reading too
    const ranged = [{ ...grid[0]!, momentRange: (time: number) => (time < 100 ? ([-12900, 480] as [number, number]) : null) }]
    expect(popupRows(ranged, 0, 50).rows[0]?.range).toBe('−12.90 kW … +480 W')
  })

  it('puts a leading line first, wherever it is drawn', () => {
    const series = [SERIES[2]!, { ...SERIES[0]!, lead: true }]
    expect(popupRows(series, 0).rows.map((r) => r.name)).toEqual(['Battery', 'PV'])
  })

  it('marks the line nearest the pointer', () => {
    expect(nearestRow([{ series: 0, y: 100 }, { series: 2, y: 40 }], 52)).toBe(2)
    expect(nearestRow([], 52)).toBeNull()
  })
})

describe('the popup placement', () => {
  it('sits beside the cursor, flips near the right edge and stays inside the plot', () => {
    expect(placePopup({ left: 200, anchorY: 100, width: 1000, height: 256, popupHeight: 140 })).toEqual({
      left: 214,
      top: 30,
      flip: false,
    })
    expect(placePopup({ left: 800, anchorY: 10, width: 1000, height: 256, popupHeight: 140 })).toEqual({
      left: 786,
      top: 0,
      flip: true,
    })
    expect(placePopup({ left: 100, anchorY: 250, width: 1000, height: 256, popupHeight: 140 }).top).toBe(116)
    // taller than the plot: overhangs both ends equally
    expect(placePopup({ left: 100, anchorY: 50, width: 1000, height: 166, popupHeight: 200 }).top).toBe(-17)
  })

  it('names the slot in the chart time zone', () => {
    // 2026-10-12 is a Monday; 07:45 UTC is 10:45 in Tallinn
    expect(slotRange(Date.parse('2026-10-12T07:45:00Z') / 1000, Date.parse('2026-10-12T08:00:00Z') / 1000, 'Europe/Tallinn')).toBe(
      'Mon 10:45–11:00',
    )
    expect(slotRange(Date.parse('2026-10-12T07:45:00Z') / 1000, Date.parse('2026-10-12T08:00:00Z') / 1000, 'Europe/Tallinn', false)).toBe(
      '10:45–11:00',
    )
  })

  it('names the pointer\'s own moment to the second', () => {
    expect(momentLabel(Date.parse('2026-10-14T06:02:14Z') / 1000 + 0.7, 'Europe/Tallinn')).toBe('Wed 09:02:14')
  })
})

describe('signed power', () => {
  it('puts the sign in front', () => {
    expect(formatSignedPower(3020)).toBe('+3.02 kW')
    expect(formatSignedPower(-850)).toBe('−850 W')
    expect(formatSignedPower(0.4)).toBe('0 W')
    expect(formatSignedPower(null)).toBe('—')
  })
})

describe('readoutText', () => {
  it('reads the rows after the moment, with their direction and the plan at the time', () => {
    expect(
      readoutText('Fri 13:25', [
        { name: 'Grid', value: '−2.55 kW', describe: 'exporting', then: '−1.04 kW' },
        { name: 'PV', value: '4.75 kW', describe: '', then: null },
      ]),
    ).toBe('Fri 13:25: Grid −2.55 kW, exporting, planned then −1.04 kW; PV 4.75 kW')
  })

  it('is just the moment without rows', () => {
    expect(readoutText('Fri 13:25', [])).toBe('Fri 13:25')
  })
})

describe('popupRows: shares, order and the total', () => {
  const part = (label: string, v: number, rank: number): PopupSeries => ({
    label,
    color: '--x',
    values: [v],
    share: true,
    popupRank: rank,
    format: (x) => x.toFixed(2),
  })
  const series: PopupSeries[] = [
    part('spot', 0.06, 4),
    part('network', 0.04, 3),
    part('VAT', 0.024, 1),
    { label: 'total', color: '--x', values: [0.124], total: true, popupRank: 5, format: (x) => x.toFixed(3) },
  ]

  it('orders the rows by rank and gives each part its share of the total', () => {
    const { rows, total } = popupRows(series, 0)
    expect(rows.map((r) => [r.name, r.share])).toEqual([
      ['VAT', '19 %'],
      ['network', '32 %'],
      ['spot', '48 %'],
      ['total', null],
    ])
    expect(total).toBeNull()
  })

  it('takes the total out of the rows for the header', () => {
    const { rows, total } = popupRows(series, 0, undefined, { totalInHead: true })
    expect(rows.map((r) => r.name)).toEqual(['VAT', 'network', 'spot'])
    expect(total?.value).toBe('0.124')
  })

  it('gives no share without a positive total', () => {
    const zero = series.map((s) => (s.total ? { ...s, values: [0] } : s))
    expect(popupRows(zero, 0).rows.every((r) => r.share === null)).toBe(true)
  })
})

describe('momentLabel with the date', () => {
  it('gives the day, the month and the moment to the second', () => {
    expect(momentLabel(Date.parse('2026-10-16T10:25:20Z') / 1000, 'Europe/Tallinn', { date: true })).toBe(
      'Fri 16 Oct · 13:25:20',
    )
  })
})

describe('popupRows: the rule after the lead rows', () => {
  it('puts a rule on the first row after the lead row, and names the plan at the time', () => {
    const series: PopupSeries[] = [
      { label: 'PV', color: '--q-pv', values: [1000] },
      { label: 'Grid', color: '--q-grid', values: [500], lead: true },
      { label: 'Grid, planned', color: '--x', values: [400], then: true, popupLabel: 'planned 6 h ahead' },
    ]
    const { rows } = popupRows(series, 0)
    expect(rows.map((r) => [r.name, r.rule])).toEqual([
      ['Grid', false],
      ['PV', true],
    ])
    expect(rows[0]?.thenName).toBe('planned 6 h ahead')
  })
})
