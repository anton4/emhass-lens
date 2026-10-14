import { describe, expect, it } from 'vitest'
import type { ButtonPress } from '../api/types'
import { PRESS_COLOR, pressButton, pressCounts, pressedOutside, pressesInSlot, pressTicks, pressWho } from './presses'

function press(at: string, source = 'unknown', button: string | null = 'apply', runId: number | null = null): ButtonPress {
  return { at, entity_id: `button.sofar_${button ?? 'old'}`, button, source, run_id: runId }
}

describe('pressWho', () => {
  it('names who pressed', () => {
    expect(pressWho(press('2026-10-13T08:00:00.000+00:00', 'lens'))).toBe('EMHASS Lens')
    expect(pressWho(press('2026-10-13T08:00:00.000+00:00', 'automation'))).toBe('an automation')
    expect(pressWho(press('2026-10-13T08:00:00.000+00:00', 'user'), true)).toBe('A user')
    expect(pressWho(press('2026-10-13T08:00:00.000+00:00', 'something new'), true)).toBe('Not known')
  })

  it('says whether EMHASS Lens pressed for the plan or for a market session', () => {
    const ours = press('2026-10-13T08:00:00.000+00:00', 'lens', 'apply', 5630)
    expect(pressWho({ ...ours, owner: 'market' }, true)).toBe('EMHASS Lens for a market session')
    expect(pressWho({ ...ours, owner: 'plan' })).toBe('EMHASS Lens for the plan')
    expect(pressWho({ ...press('2026-10-13T08:00:00.000+00:00', 'user'), owner: 'plan' })).toBe('a user')
  })
})

describe('pressButton', () => {
  it('names the button by what it commits, else by its entity', () => {
    expect(pressButton(press('2026-10-13T08:00:00.000+00:00'))).toBe('Passive settings')
    expect(pressButton(press('2026-10-13T08:00:00.000+00:00', 'user', 'feedin'))).toBe('Feed-in limit')
    expect(pressButton(press('2026-10-13T08:00:00.000+00:00', 'user', null))).toBe('button.sofar_old')
  })
})

describe('pressesInSlot', () => {
  it('keeps the presses of one quarter-hour, oldest first', () => {
    const slot = Date.parse('2026-10-13T08:00:00.000+00:00')
    const presses = [
      press('2026-10-13T08:15:00.000+00:00'),
      press('2026-10-13T08:14:59.000+00:00', 'automation'),
      press('2026-10-13T08:00:00.000+00:00', 'lens'),
      press('2026-10-13T07:59:59.000+00:00'),
    ]
    expect(pressesInSlot(presses, slot).map((p) => p.source)).toEqual(['lens', 'automation'])
  })
})

describe('pressTicks and pressCounts', () => {
  const presses = [
    press('2026-10-13T08:00:00.000+00:00', 'lens'),
    press('2026-10-13T09:00:00.000+00:00', 'user'),
    press('2026-10-12T23:00:00.000+00:00', 'automation'),
  ]

  it('marks a press from outside EMHASS Lens in its own colour', () => {
    expect(pressedOutside(presses[0]!)).toBe(false)
    expect(pressTicks(presses)).toEqual([
      { t: Date.parse('2026-10-13T08:00:00Z') / 1000, color: PRESS_COLOR.lens },
      { t: Date.parse('2026-10-13T09:00:00Z') / 1000, color: PRESS_COLOR.outside },
      { t: Date.parse('2026-10-12T23:00:00Z') / 1000, color: PRESS_COLOR.outside },
    ])
  })

  it('counts the presses within a day', () => {
    expect(pressCounts(presses, '2026-10-13T00:00:00.000Z', '2026-10-14T00:00:00.000Z')).toEqual({ outside: 1, lens: 1 })
  })
})
