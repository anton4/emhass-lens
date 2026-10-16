// The overview strip under the Plan's charts: the grid's line, solid where it was measured and dashed where it is the
// plan, how often a day gets its name, and the brush's look while it is pointed at or dragged.

/** The step line through `values` (one per slot start in `x`, each holding to the next) as SVG paths: the slots that
 *  start before `nowS` in `past`, the rest in `future`. A missing value breaks the line. */
export function overviewPaths(
  x: number[],
  values: (number | null)[],
  nowS: number,
  toX: (t: number) => number,
  toY: (v: number) => number,
  slotS = 900,
): { past: string; future: string } {
  const out = { past: '', future: '' }
  let prev: { side: 'past' | 'future'; known: boolean } | null = null
  x.forEach((t, i) => {
    const v = values[i]
    const side = t < nowS ? 'past' : 'future'
    if (v === null || v === undefined || !Number.isFinite(v)) {
      prev = { side, known: false }
      return
    }
    const a = toX(t).toFixed(1)
    const b = toX(x[i + 1] ?? t + slotS).toFixed(1)
    const y = toY(v).toFixed(1)
    const join = prev !== null && prev.known && prev.side === side
    out[side] += join ? `V${y}H${b}` : `M${a} ${y}H${b}`
    prev = { side, known: true }
  })
  return out
}

/** Every how many days a day gets its name under the overview: each one when a day has room, else every second. */
export function dayLabelEvery(pxPerDay: number): 1 | 2 {
  return pxPerDay < 70 ? 2 : 1
}

/** How the brush looks: as it is, pointed at (an edge's handle grows), or being dragged. */
export function brushState(pointed: 'start' | 'end' | 'move' | null, dragging: boolean): 'idle' | 'handle' | 'drag' {
  if (dragging) return 'drag'
  return pointed ? 'handle' : 'idle'
}
