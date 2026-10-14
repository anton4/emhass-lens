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
