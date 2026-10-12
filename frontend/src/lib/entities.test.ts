import { describe, expect, it } from 'vitest'
import { entityDomains, entityReading, matchSegments } from './entities'

describe('entityDomains', () => {
  it('accepts one domain, a list or nothing', () => {
    expect(entityDomains('sensor')).toEqual(['sensor'])
    expect(entityDomains(['sensor', 'input_number'])).toEqual(['sensor', 'input_number'])
    expect(entityDomains(undefined)).toEqual([])
  })
})

describe('entityReading', () => {
  it('adds the unit only to real values', () => {
    expect(entityReading({ state: '62', unit: '%' })).toBe('62 %')
    expect(entityReading({ state: 'on', unit: null })).toBe('on')
    expect(entityReading({ state: 'unavailable', unit: '%' })).toBe('unavailable')
    expect(entityReading({ state: null, unit: '%' })).toBe('')
  })

  const tz = 'Europe/Tallinn'
  it("shows a button's last press in the App's timezone, not Home Assistant's UTC ISO", () => {
    const summer = entityReading(
      { entity_id: 'button.sofar_feedin_limitation_mode', state: '2026-10-12T10:15:02.322394+00:00' },
      tz,
    )
    expect(summer).toMatch(/^pressed /)
    expect(summer).toContain('13:15:02')
    expect(entityReading({ entity_id: 'button.abb_start', state: '2026-01-12T10:15:02+00:00' }, tz)).toContain('12:15:02')
  })

  it('formats other moments without "pressed", and leaves everything else alone', () => {
    const sensor = { entity_id: 'sensor.last_boot', state: '2026-10-12T19:15:02+00:00', device_class: 'timestamp' }
    expect(entityReading(sensor, tz)).toContain('22:15:02')
    expect(entityReading(sensor, tz)).not.toMatch(/pressed/)
    expect(entityReading({ entity_id: 'button.abb_start', state: 'unknown' }, tz)).toBe('unknown')
    expect(entityReading({ entity_id: 'button.abb_start', state: '2' }, tz)).toBe('2')
    expect(entityReading({ entity_id: 'sensor.soc', state: '62', unit: '%', device_class: 'battery' }, tz)).toBe('62 %')
  })
})

describe('matchSegments', () => {
  it('marks every occurrence of every search word, ignoring case', () => {
    expect(matchSegments('sensor.ev6_battery_soc', 'SOC ev6')).toEqual([
      { text: 'sensor.', match: false },
      { text: 'ev6', match: true },
      { text: '_battery_', match: false },
      { text: 'soc', match: true },
    ])
  })

  it('merges overlapping matches and handles no search', () => {
    expect(matchSegments('aaa', 'aa a')).toEqual([{ text: 'aaa', match: true }])
    expect(matchSegments('Grid power', '')).toEqual([{ text: 'Grid power', match: false }])
    expect(matchSegments('', 'x')).toEqual([])
  })
})
