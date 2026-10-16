import { describe, expect, it } from 'vitest'
import { adaptiveStep, applyKey, keyCommand, keyHint } from './chartKeys'

const key = (k: string, shiftKey = false) => ({ key: k, shiftKey })
const STEP = { step: 900, big: 3600 }
const base = { cursor: 5000, window: [3600, 7200] as [number, number], bounds: [0, 36000] as [number, number], step: STEP }

describe('keyCommand', () => {
  it('reads the arrow keys, zoom, page, Home and Escape', () => {
    expect(keyCommand(key('ArrowLeft'))).toEqual({ kind: 'step', dir: -1, big: false })
    expect(keyCommand(key('ArrowRight', true))).toEqual({ kind: 'step', dir: 1, big: true })
    expect(keyCommand(key('+'))).toEqual({ kind: 'zoom', factor: 0.7 })
    expect(keyCommand(key('='))).toEqual({ kind: 'zoom', factor: 0.7 })
    expect(keyCommand(key('-'))).toEqual({ kind: 'zoom', factor: 1.4 })
    expect(keyCommand(key('PageDown'))).toEqual({ kind: 'page', dir: 1 })
    expect(keyCommand(key('Home'))).toEqual({ kind: 'home' })
    expect(keyCommand(key('Escape'))).toEqual({ kind: 'cancel' })
  })

  it('leaves other keys and shortcuts alone', () => {
    expect(keyCommand(key('Tab'))).toBeNull()
    expect(keyCommand({ key: 'ArrowLeft', shiftKey: false, metaKey: true })).toBeNull()
  })
})

describe('applyKey', () => {
  it('steps the cursor inside the window without moving it', () => {
    expect(applyKey({ kind: 'step', dir: 1, big: false }, base)).toEqual({ cursor: 5900 })
    expect(applyKey({ kind: 'step', dir: -1, big: true }, base)).toEqual({ cursor: 1400, window: [1220, 4820] })
  })

  it('moves the window when the cursor steps past its edge', () => {
    const out = applyKey({ kind: 'step', dir: 1, big: true }, { ...base, cursor: 7000 })
    expect(out.cursor).toBe(10600)
    expect(out.window).toEqual([7180, 10780])
  })

  it('keeps the cursor inside the bounds', () => {
    expect(applyKey({ kind: 'step', dir: -1, big: true }, { ...base, cursor: 1000, window: [0, 3600] }).cursor).toBe(0)
  })

  it('zooms around the cursor', () => {
    const out = applyKey({ kind: 'zoom', factor: 0.5 }, { ...base, cursor: 5400 })
    expect(out).toEqual({ cursor: 5400, window: [4500, 6300] })
  })

  it('pages the window by half its width, the cursor with it', () => {
    expect(applyKey({ kind: 'page', dir: 1 }, base)).toEqual({ cursor: 6800, window: [5400, 9000] })
  })

  it('asks to go home, and puts the cursor away on Escape', () => {
    expect(applyKey({ kind: 'home' }, base)).toEqual({ cursor: null, home: true })
    expect(applyKey({ kind: 'cancel' }, base)).toEqual({ cursor: null })
  })
})

describe('adaptiveStep', () => {
  it('steps 10 s within two hours and a quarter-hour beyond', () => {
    expect(adaptiveStep(7200)).toEqual({ step: 10, big: 300 })
    expect(adaptiveStep(8 * 3600)).toEqual({ step: 900, big: 3600 })
  })
})

describe('keyHint', () => {
  it('names the steps', () => {
    expect(keyHint({ step: 10, big: 300 })).toBe('Arrow keys move the cursor by 10 s, with Shift by 5 min')
    expect(keyHint(STEP)).toBe('Arrow keys move the cursor by a quarter-hour, with Shift by an hour')
  })
})
