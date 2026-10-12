import { describe, expect, it } from 'vitest'
import { nearestRow, placePopup, popupRows, slotRange, type PopupSeries } from './chartPopup'
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
