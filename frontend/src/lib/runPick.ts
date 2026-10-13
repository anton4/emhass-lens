// Ticking runs on the Runs page to download several at once.

/** The most runs one download takes (the backend's MAX_DOWNLOAD): their ids must fit in a URL behind Ingress. */
export const MAX_DOWNLOAD = 200

export type TickState = 'none' | 'some' | 'all'

/** `selected` with `ids` ticked (`on`) or unticked; a new set, `selected` is left alone. */
export function toggled(selected: ReadonlySet<number>, ids: readonly number[], on: boolean): Set<number> {
  const next = new Set(selected)
  for (const id of ids) {
    if (on) next.add(id)
    else next.delete(id)
  }
  return next
}

/** A shift-click: the rows from the last box clicked to this one, both included, in the order shown. Just this
 * row when the last one clicked is no longer shown. */
export function span(shown: readonly number[], anchor: number | null, id: number): number[] {
  const from = anchor === null ? -1 : shown.indexOf(anchor)
  const to = shown.indexOf(id)
  if (from < 0 || to < 0) return [id]
  return shown.slice(Math.min(from, to), Math.max(from, to) + 1)
}

/** How many of the rows shown are ticked, for the select-all box. */
export function tickState(shown: readonly number[], selected: ReadonlySet<number>): TickState {
  const ticked = shown.filter((id) => selected.has(id)).length
  return ticked === 0 ? 'none' : ticked === shown.length ? 'all' : 'some'
}
