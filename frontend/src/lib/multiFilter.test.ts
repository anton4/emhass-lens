import { describe, expect, it } from 'vitest'
import { multiQuery, multiSummary, readMulti, writeMulti } from './multiFilter'

describe('readMulti', () => {
  it('reads kept values, left-out values or none', () => {
    expect(readMulti(new URLSearchParams('job=a&job=b'), 'job')).toEqual({ values: ['a', 'b'], exclude: false })
    expect(readMulti(new URLSearchParams('not_job=a'), 'job')).toEqual({ values: ['a'], exclude: true })
    expect(readMulti(new URLSearchParams('outcome=ok'), 'job')).toEqual({ values: [], exclude: false })
  })
  it('reads an old single-value link', () => {
    expect(readMulti(new URLSearchParams('job=emhass.mpc'), 'job')).toEqual({ values: ['emhass.mpc'], exclude: false })
  })
})

describe('writeMulti', () => {
  it('replaces both keys and leaves the others alone', () => {
    const params = new URLSearchParams('job=a&run=7')
    writeMulti(params, 'job', { values: ['b', 'c'], exclude: true })
    expect(params.toString()).toBe('run=7&not_job=b&not_job=c')
    writeMulti(params, 'job', { values: [], exclude: true })
    expect(params.toString()).toBe('run=7')
  })
})

describe('multiQuery', () => {
  it('names the key by the mode and sends nothing without values', () => {
    expect(multiQuery('outcome', { values: ['ok'], exclude: false })).toEqual({ outcome: ['ok'] })
    expect(multiQuery('outcome', { values: ['ok'], exclude: true })).toEqual({ not_outcome: ['ok'] })
    expect(multiQuery('outcome', { values: [], exclude: true })).toEqual({})
  })
})

describe('multiSummary', () => {
  it('says what the filter keeps', () => {
    expect(multiSummary('jobs', [], false)).toBe('All jobs')
    expect(multiSummary('jobs', [], true)).toBe('All jobs')
    expect(multiSummary('jobs', ['MPC run'], false)).toBe('MPC run')
    expect(multiSummary('jobs', ['MPC run', 'Prices'], false)).toBe('2 jobs')
    expect(multiSummary('jobs', ['MPC run'], true)).toBe('All but MPC run')
    expect(multiSummary('outcomes', ['OK', 'Error', 'Skipped'], true)).toBe('All but 3 outcomes')
  })
})
