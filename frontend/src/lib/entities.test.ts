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
