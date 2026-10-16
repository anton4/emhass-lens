// What TimeChart's uPlot hooks hand its value popup: the plot to draw in and where the cursor is. A tiny store, so a
// cursor move re-renders the popup and nothing else.

export interface PopupTag {
  text: string
  tone?: 'neutral' | 'blue'
}

/** A row the popup adds under the lines' rows: what a lane says at the cursor, or a value not drawn as a line. */
export interface PopupExtra {
  name: string
  value: string
  /** CSS custom property or colour of its square swatch. */
  color: string
  /** A hatched swatch (a span that is off). */
  hatch?: boolean
  /** The swatch: a square (default), a line, a dashed line, or none. */
  swatch?: 'square' | 'line' | 'dash' | 'none'
}

/** A line of the chip a chart shows at its cursor instead of a popup ("run #4554 · ok"). */
export interface PopupChip {
  text: string
  /** CSS custom property or colour of the text. */
  color?: string
}

/** A tinted block above the lines' rows: what was going on at the pointer's moment (a market command), its rows, and
 *  a few lines under a rule (the session it belongs to). */
export interface PopupBlock {
  /** "↑ SELL" */
  title: string
  /** "kratt · mfrrup" */
  sub?: string
  tone: 'sell' | 'buy'
  rows: {
    name: string
    value: string
    /** Muted text after the value ("since 09:01:50"). */
    note?: string
    /** CSS custom property or colour of its swatch. */
    color: string
    /** A bold line, a thin line or a hatched square. */
    swatch: 'line' | 'thin' | 'hatch'
    /** Name and value in the swatch's colour (a shortfall). */
    alert?: boolean
  }[]
  foot?: string[]
  /** A line under the title ("10.62 of 11.00 kW delivered (97 %)"). */
  text?: string
  /** A bar filled to this share (0–1) under the text. */
  meter?: number
}

/** Where the cursor is, in plot pixels; `pointerY` only on the chart under the pointer. */
export interface CursorAt {
  idx: number
  /** The time under the pointer (unix s); a chart that snaps to slots gives the slot's start. */
  time: number
  left: number
  pointerY: number | null
  /** The height of each (non-"then") series' value at idx. */
  points: { series: number; y: number }[]
  width: number
  height: number
  /** The column at idx, on a chart of columns: ringed, and the popup sits beside it. */
  column?: { left: number; width: number; top: number; height: number }
  /** Dots on the overlays that have one, at the cursor (plot px, CSS colour). */
  marks?: { y: number; color: string }[]
}

interface Snapshot {
  over: HTMLElement | null
  at: CursorAt | null
}

/** One per chart. */
export function createCursorStore() {
  let snapshot: Snapshot = { over: null, at: null }
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((l) => l())
  return {
    get: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setOver(over: HTMLElement | null) {
      snapshot = { over, at: null }
      emit()
    },
    setAt(at: CursorAt | null) {
      if (at === null && snapshot.at === null) return
      snapshot = { ...snapshot, at }
      emit()
    },
  }
}

export type CursorStore = ReturnType<typeof createCursorStore>

/** A value that changes often (the cursor's time) for one part of a page to follow without re-rendering the rest. */
export function createValueStore<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return
      value = next
      listeners.forEach((l) => l())
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export type ValueStore<T> = ReturnType<typeof createValueStore<T>>
