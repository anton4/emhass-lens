import { describe, expect, it } from 'vitest'
import type { GridDetail } from '../api/types'
import { DETAIL_MAX_S, detailRequest, gridDetailLabel, gridOverlay, gridRows } from './gridDetail'

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

  it('names the chip by how fine the line is', () => {
    expect(gridDetailLabel(undefined)).toBe('Grid in detail')
    expect(gridDetailLabel(null)).toBe('Grid, each change')
    expect(gridDetailLabel(10)).toBe('Grid every 10 s')
    expect(gridDetailLabel(120)).toBe('Grid every 2 min')
  })

  it('reads the value under the pointer: its bucket, or its moment when every change is a point', () => {
    const tz = 'Europe/Tallinn'
    expect(gridRows(detail, s('2026-10-14T05:45:20Z'), tz)).toEqual([
      { name: 'Grid measured', value: '−9.31 kW · 08:45:12–08:45:30', color: '--q-grid' },
    ])
    expect(gridRows({ ...detail, step_s: null }, s('2026-10-14T05:45:05Z'), tz)[0]?.value).toBe('+480 W at 08:45:05')
    expect(gridRows(detail, s('2026-10-14T05:44:59Z'), tz)).toEqual([])
    expect(gridRows(detail, s('2026-10-14T05:45:35Z'), tz)).toEqual([]) // the sensor had no value
    expect(gridRows(detail, s(detail.end), tz)).toEqual([])
    expect(gridRows(undefined, s('2026-10-14T05:45:20Z'), tz)).toEqual([])
  })
})
