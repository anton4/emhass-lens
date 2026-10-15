import { describe, expect, it } from 'vitest'
import type { GridDetail } from '../api/types'
import { DETAIL_MAX_S, detailCover, detailRequest, gridAt, gridDetailNote, gridOverlay, planTail, withoutCovered } from './gridDetail'

const s = (iso: string) => Date.parse(iso) / 1000
const NOW = s('2026-10-14T09:13:20Z')

describe('detailRequest', () => {
  it('asks for the measured part of the whole axis from its hour, up to now', () => {
    const req = detailRequest([s('2026-10-13T09:15:00Z'), s('2026-10-15T00:00:00Z')], NOW, false)
    expect(req).toEqual({ since: '2026-10-13T09:00:00.000Z', until: null, maxPoints: 1000 })
    // a quarter-hour later the axis has moved on, the request hasn't
    expect(detailRequest([s('2026-10-13T09:30:00Z'), s('2026-10-15T00:15:00Z')], NOW + 900, false)).toEqual(req)
  })

  it('keeps to the last 48 h, from a whole hour so the request stays put', () => {
    const week = detailRequest([s('2026-10-07T09:15:00Z'), s('2026-10-15T00:00:00Z')], NOW, false)
    expect(week?.since).toBe('2026-10-12T10:00:00.000Z')
    expect(week?.until).toBeNull()
  })

  it('takes a zoom as it is, closed when it ends before now', () => {
    const zoom: [number, number] = [s('2026-10-14T05:30:00Z'), s('2026-10-14T06:30:00Z')]
    expect(detailRequest(zoom, NOW, true)).toEqual({
      since: '2026-10-14T05:30:00.000Z',
      until: '2026-10-14T06:30:00.000Z',
      maxPoints: 1500,
    })
    const longAgo: [number, number] = [NOW - 4 * 86400, NOW - 3 * 86400]
    expect(detailRequest(longAgo, NOW, true)?.since).toBe(new Date((NOW - 3 * 86400 - DETAIL_MAX_S + 86400) * 1000).toISOString())
  })

  it('asks nothing for a window that is all ahead', () => {
    expect(detailRequest([NOW + 60, NOW + 3600], NOW, true)).toBeNull()
  })
})

const detail: GridDetail = {
  entity: 'sensor.grid',
  start: '2026-10-14T05:45:00.000+00:00',
  end: '2026-10-14T05:46:00.000+00:00',
  step_s: 10,
  points: [
    { t: '2026-10-14T05:45:00.000+00:00', w: 480 },
    { t: '2026-10-14T05:45:12.000+00:00', w: -9310 },
    { t: '2026-10-14T05:45:30.000+00:00', w: null },
    { t: '2026-10-14T05:45:40.000+00:00', w: -9280 },
  ],
  error: null,
}

describe('the measured grid line', () => {
  it('holds each point until the next one and leaves a gap where there was no value', () => {
    const overlay = gridOverlay(detail)
    expect(overlay.base).toBe('none')
    expect(overlay.spans).toEqual([
      { from: s(detail.points[0]!.t), to: s(detail.points[1]!.t), value: 480 },
      { from: s(detail.points[1]!.t), to: s(detail.points[2]!.t), value: -9310 },
      { from: s(detail.points[3]!.t), to: s(detail.end), value: -9280 },
    ])
  })

  it('says how fine the line is', () => {
    expect(gridDetailNote(undefined)).toBeNull()
    expect(gridDetailNote(null)).toBe('measured at each change')
    expect(gridDetailNote(10)).toBe('measured every 10 s')
    expect(gridDetailNote(120)).toBe('measured every 2 min')
  })

  it('reads the value under the pointer: its bucket, or its moment when every change is a point', () => {
    expect(gridAt(detail, s('2026-10-14T05:45:20Z'))).toBe(-9310)
    expect(gridAt({ ...detail, step_s: null }, s('2026-10-14T05:45:05Z'))).toBe(480)
    expect(gridAt(detail, s('2026-10-14T05:44:59Z'))).toBeNull()
    expect(gridAt(detail, s('2026-10-14T05:45:35Z'))).toBeNull() // the sensor had no value
    expect(gridAt(detail, s(detail.end))).toBeNull()
    expect(gridAt(undefined, s('2026-10-14T05:45:20Z'))).toBeNull()
  })

  it('takes over the quarter-hours it covers from the grid line', () => {
    const cover = detailCover({ ...detail, start: '2026-10-14T05:00:00Z', end: '2026-10-14T06:00:00Z' })
    expect(cover).toEqual([s('2026-10-14T05:00:00Z'), s('2026-10-14T06:00:00Z')])
    const x = ['04:45', '05:00', '05:15', '05:30', '05:45', '06:00', '06:15'].map((t) => s(`2026-10-14T${t}:00Z`))
    const values = [1, 2, 3, 4, 5, 6, 7]
    // 05:00 to 06:00 is measured and covered; the plan from 06:00 stays
    expect(withoutCovered(x, values, cover, s('2026-10-14T06:00:00Z'))).toEqual([1, null, null, null, null, 6, 7])
    expect(planTail(x, values, cover, s('2026-10-14T06:00:00Z'))).toBeNull()
    expect(withoutCovered(x, values, null, s('2026-10-14T06:00:00Z'))).toBe(values)
    expect(detailCover({ ...detail, points: [] })).toBeNull()
  })

  it("draws the plan's slot in progress only from where the measured line ends, so the grid is one line", () => {
    // now is 06:07: the detail runs to now, inside the plan's slot from 06:00
    const cover: [number, number] = [s('2026-10-14T05:30:00Z'), s('2026-10-14T06:07:00Z')]
    const x = ['05:30', '05:45', '06:00', '06:15'].map((t) => s(`2026-10-14T${t}:00Z`))
    const values = [1, 2, 3, 4]
    expect(withoutCovered(x, values, cover, s('2026-10-14T06:00:00Z'))).toEqual([null, null, null, 4])
    expect(planTail(x, values, cover, s('2026-10-14T06:00:00Z'))).toEqual([
      { from: s('2026-10-14T06:07:00Z'), to: s('2026-10-14T06:15:00Z'), value: 3 },
      { from: s('2026-10-14T06:15:00Z'), to: s('2026-10-14T06:15:00Z'), value: 4 }, // the step up to the next slot
    ])
    expect(planTail(x, values, null, s('2026-10-14T06:00:00Z'))).toBeNull()
  })
})
