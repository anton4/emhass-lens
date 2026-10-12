// What TimeChart's uPlot hooks hand its value popup: the plot to draw in and where the cursor is. A tiny store, so a
// cursor move re-renders the popup and nothing else.

export interface PopupTag {
  text: string
  tone?: 'neutral' | 'blue'
}

/** Where the cursor is, in plot pixels; `pointerY` only on the chart under the pointer. */
export interface CursorAt {
  idx: number
  left: number
  pointerY: number | null
  /** The height of each (non-"then") series' value at idx. */
  points: { series: number; y: number }[]
  width: number
  height: number
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
