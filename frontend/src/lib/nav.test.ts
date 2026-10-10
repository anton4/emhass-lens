import { describe, expect, it } from 'vitest'
import { NAV_PAGES, navLocation, pageForKey } from './nav'

describe('navLocation', () => {
  it('finds the group and page of a path', () => {
    expect(navLocation('/').page.label).toBe('Plan')
    expect(navLocation('/').group.label).toBe('Operate')
    expect(navLocation('/charger').group.label).toBe('Control')
    expect(navLocation('/settings').page.label).toBe('Settings')
  })

  it('puts a run under Runs', () => {
    const where = navLocation('/runs/985')
    expect(where.page.label).toBe('Runs')
    expect(where.group.label).toBe('Diagnose')
  })

  it('falls back to Plan for unknown paths', () => {
    expect(navLocation('/nowhere').page.to).toBe('/')
  })
})

describe('pageForKey', () => {
  it('maps the second key of a "g" shortcut to its page', () => {
    expect(pageForKey('r')?.to).toBe('/runs')
    expect(pageForKey('S')?.to).toBe('/settings')
    expect(pageForKey('x')).toBeUndefined()
  })

  it('gives every page a unique shortcut letter', () => {
    const keys = NAV_PAGES.flatMap((p) => (p.key ? [p.key] : []))
    expect(new Set(keys).size).toBe(keys.length)
  })
})
