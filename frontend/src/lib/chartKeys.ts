// Moving along a chart with the keyboard: what a key asks for, where it takes the cursor and the window, and how far
// a step goes at the window shown.

import { panBy, zoomAround } from './chartRange'
import { spanLabel } from './chartTime'

/** How far ← → move the cursor, and with Shift (seconds). */
export interface KeyStep {
  step: number
  big: number
}

export type KeyCommand =
  | { kind: 'step'; dir: -1 | 1; big: boolean }
  | { kind: 'zoom'; factor: number }
  | { kind: 'page'; dir: -1 | 1 }
  | { kind: 'home' }
  | { kind: 'cancel' }

/** What a key press asks the chart for, or null for a key it leaves alone (Tab, shortcuts with Ctrl, Alt or ⌘). */
export function keyCommand(e: {
  key: string
  shiftKey: boolean
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}): KeyCommand | null {
  if (e.altKey || e.ctrlKey || e.metaKey) return null
  switch (e.key) {
    case 'ArrowLeft':
      return { kind: 'step', dir: -1, big: e.shiftKey }
    case 'ArrowRight':
      return { kind: 'step', dir: 1, big: e.shiftKey }
    case '+':
    case '=':
      return { kind: 'zoom', factor: 0.7 }
    case '-':
    case '_':
      return { kind: 'zoom', factor: 1.4 }
    case 'PageUp':
      return { kind: 'page', dir: -1 }
    case 'PageDown':
      return { kind: 'page', dir: 1 }
    case 'Home':
      return { kind: 'home' }
    case 'Escape':
      return { kind: 'cancel' }
    default:
      return null
  }
}

/** Where `cmd` takes the cursor (unix s, null when it is put away) and, when it moves, the window: a step past the
 *  window's edge moves the window with it; zooming keeps the cursor where it is. `home` asks the chart to go back to
 *  its own window. */
export function applyKey(
  cmd: KeyCommand,
  o: { cursor: number; window: [number, number]; bounds: [number, number]; step: KeyStep },
): { cursor: number | null; window?: [number, number]; home?: true } {
  const [a, b] = o.window
  const span = b - a
  switch (cmd.kind) {
    case 'step': {
      const cursor = Math.min(Math.max(o.cursor + cmd.dir * (cmd.big ? o.step.big : o.step.step), o.bounds[0]), o.bounds[1])
      // a little room ahead of the cursor once the window has to follow it
      if (cursor < a) return { cursor, window: panBy(o.window, cursor - a - span * 0.05, o.bounds) }
      if (cursor > b) return { cursor, window: panBy(o.window, cursor - b + span * 0.05, o.bounds) }
      return { cursor }
    }
    case 'zoom':
      return { cursor: o.cursor, window: zoomAround(o.window, o.cursor, cmd.factor, o.bounds) }
    case 'page': {
      const window = panBy(o.window, cmd.dir * span * 0.5, o.bounds)
      return { cursor: Math.min(Math.max(o.cursor + (window[0] - a), window[0]), window[1]), window }
    }
    case 'home':
      return { cursor: null, home: true }
    case 'cancel':
      return { cursor: null }
  }
}

/** The arrow keys' step for a window of `windowS` seconds: a 10-second reading (Shift 5 min) when it is 2 h or less,
 *  a quarter-hour (Shift an hour) otherwise. */
export function adaptiveStep(windowS: number): KeyStep {
  return windowS <= 2 * 3600 ? { step: 10, big: 300 } : { step: 900, big: 3600 }
}

const stepName = (s: number) => (s === 900 ? 'a quarter-hour' : s === 3600 ? 'an hour' : spanLabel(s))

/** "Arrow keys move the cursor by a quarter-hour, with Shift by an hour". */
export function keyHint(step: KeyStep): string {
  return `Arrow keys move the cursor by ${stepName(step.step)}, with Shift by ${stepName(step.big)}`
}
