import { describe, expect, it } from 'vitest'
import type { GridDetail } from '../api/types'
import {
  DETAIL_MAX_S,
  detailCover,
  detailRequest,
  gridAt,
  gridCadence,
  gridDetailNote,
  gridOverlay,
  gridRangeAt,
  lastReading,
  missingStretches,
  planTail,
  readingsPhrase,
  withoutCovered,
} from './gridDetail'

const s = (iso: string) => Date.parse(iso) / 1000
const NOW = s('2026-10-14T09:13:20Z')

describe('detailRequest', () => {
  it('asks for the measured part of the whole axis from its hour, up to now', () => {
    const req = detailRequest([s('2026-10-13T09:15:00Z'), s('2026-10-15T00:00:00Z')], NOW, false)
    expect(req).toEqual({ since: '2026-10-13T09:00:00.000Z', until: null, maxPoints: 3000 })
    // a quarter-hour later the axis has moved on, the request hasn't
    expect(detailRequest([s('2026-10-13T09:30:00Z'), s('2026-10-15T00:15:00Z')], NOW + 900, false)).toEqual(req)
  })

  it('keeps to the last 8 days, from a whole hour so the request stays put', () => {
    const long = detailRequest([s('2026-10-01T09:15:00Z'), s('2026-10-15T00:00:00Z')], NOW, false)
    expect(long?.since).toBe('2026-10-06T10:00:00.000Z')
    expect(long?.until).toBeNull()
    // a week is all there
    const week = detailRequest([s('2026-10-07T09:15:00Z'), s('2026-10-15T00:00:00Z')], NOW, false)
    expect(week?.since).toBe('2026-10-07T09:00:00.000Z')
  })

  it('takes a zoom as it is, closed when it ends before now', () => {
    const zoom: [number, number] = [s('2026-10-14T05:30:00Z'), s('2026-10-14T06:30:00Z')]
    expect(detailRequest(zoom, NOW, true)).toEqual({
      since: '2026-10-14T05:30:00.000Z',
      until: '2026-10-14T06:30:00.000Z',
      maxPoints: 3000,
    })
    const longAgo: [number, number] = [NOW - 12 * 86400, NOW - 3 * 86400]
    expect(detailRequest(longAgo, NOW, true)?.since).toBe(new Date((NOW - 3 * 86400 - DETAIL_MAX_S) * 1000).toISOString())
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

  it("carries a mean's lowest and highest reading, and reads them at the pointer", () => {
    const means: GridDetail = {
      ...detail,
      step_s: 30,
      points: [
        { t: '2026-10-14T05:45:00.000+00:00', w: 503, lo: 490, hi: 510 },
        { t: '2026-10-14T05:45:30.000+00:00', w: -8100, lo: -12900, hi: 480 },
      ],
    }
    expect(gridOverlay(means).spans).toEqual([
      { from: s(means.points[0]!.t), to: s(means.points[1]!.t), value: 503, lo: 490, hi: 510 },
      { from: s(means.points[1]!.t), to: s(means.end), value: -8100, lo: -12900, hi: 480 },
    ])
    expect(gridRangeAt(means, s('2026-10-14T05:45:40Z'))).toEqual([-12900, 480])
    expect(gridRangeAt(detail, s('2026-10-14T05:45:20Z'))).toBeNull() // a raw change has no range
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

describe('gridCadence and lastReading', () => {
  const raw = (gaps: number[], nulls: number[] = []): GridDetail => {
    let t = Date.parse('2026-10-16T10:00:00Z') / 1000
    const points = [t, ...gaps.map((g) => (t += g))].map((s, i) => ({
      t: new Date(s * 1000).toISOString(),
      w: nulls.includes(i) ? null : 100,
    }))
    return { entity: 'sensor.grid', start: points[0]!.t, end: points[points.length - 1]!.t, step_s: null, points, error: null }
  }

  it('is the median gap between readings', () => {
    expect(gridCadence(raw([10, 10, 30, 10, 11]))).toBe(10)
    // a meter reporting several times a second isn't "every 0-second" (2026-10-26)
    expect(gridCadence(raw([0.25, 0.25, 6, 0.25, 0.25]))).toBe(0.25)
  })

  it('is null for means per step, or too few readings', () => {
    expect(gridCadence({ ...raw([10, 10, 10]), step_s: 60 })).toBeNull()
    expect(gridCadence(raw([10]))).toBeNull()
    expect(gridCadence(undefined)).toBeNull()
  })

  it('finds the last reading, past any missing ones', () => {
    const d = raw([10, 10, 10], [3])
    expect(lastReading(d)).toBe(Date.parse('2026-10-16T10:00:20Z') / 1000)
    expect(lastReading(undefined)).toBeNull()
  })
})

describe('readingsPhrase', () => {
  it('says what the grid line is made of', () => {
    expect(readingsPhrase(null, 10)).toBe('every 10-second grid reading from Home Assistant')
    expect(readingsPhrase(null, 0.25)).toBe('every grid reading from Home Assistant (several a second)')
    expect(readingsPhrase(null, 120)).toBe('every grid reading from Home Assistant (about one every 2 min)')
    expect(readingsPhrase(60, null)).toBe(
      "the grid's readings from Home Assistant as 1-minute means, drawn through each one's lowest and highest",
    )
    expect(readingsPhrase(undefined, null)).toBe('quarter-hour means')
  })
})

describe('missingStretches', () => {
  const t = (m: number) => new Date(Date.parse('2026-10-16T10:00:00Z') + m * 60_000).toISOString()
  const detail = (ws: (number | null)[]): GridDetail => ({
    entity: 'sensor.grid',
    start: t(0),
    end: t(ws.length),
    step_s: 60,
    points: ws.map((w, i) => ({ t: t(i), w })),
    error: null,
  })

  it('joins back-to-back missing points into stretches of at least a minute', () => {
    expect(missingStretches(detail([1, null, null, 2, null, 3]))).toEqual([
      { from: Date.parse(t(1)) / 1000, to: Date.parse(t(3)) / 1000 },
      { from: Date.parse(t(4)) / 1000, to: Date.parse(t(5)) / 1000 },
    ])
    expect(missingStretches(detail([1, null, 2]), 120)).toEqual([])
    expect(missingStretches(undefined)).toEqual([])
  })
})
