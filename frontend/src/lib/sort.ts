// Sorting table rows by a column: stable, unknown values last in either direction.

export type SortDir = 'asc' | 'desc'

export interface SortState {
  key: string
  dir: SortDir
}

export function sortRows<T>(
  rows: readonly T[],
  get: (row: T) => string | number | null | undefined,
  dir: SortDir,
): T[] {
  return rows
    .map((row, index) => ({ row, index, value: get(row) }))
    .sort((a, b) => {
      const va = a.value
      const vb = b.value
      const aNone = va === null || va === undefined || va === ''
      const bNone = vb === null || vb === undefined || vb === ''
      if (aNone || bNone) return aNone === bNone ? a.index - b.index : aNone ? 1 : -1
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
      return (dir === 'asc' ? cmp : -cmp) || a.index - b.index
    })
    .map((x) => x.row)
}

/** Clicking a column: the same one flips its direction, another one starts with `firstDir`. */
export function nextSort(current: SortState, key: string, firstDir: SortDir = 'desc'): SortState {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  return { key, dir: firstDir }
}

/** Case-insensitive search over a row's texts; every word must appear somewhere. */
export function matchesSearch(texts: readonly (string | null | undefined)[], query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = texts.filter(Boolean).join(' ').toLowerCase()
  return words.every((w) => haystack.includes(w))
}
