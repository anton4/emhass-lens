import { describe, expect, it } from 'vitest'
import { NAV_PAGES, pageForKey } from './nav'

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
