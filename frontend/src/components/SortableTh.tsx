import type { SortState } from '../lib/sort'

/** A column header that sorts the table: click to sort by it, click again to flip the direction. */
export function SortableTh({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string
  sortKey: string
  sort: SortState
  onSort: (key: string) => void
  className?: string
}) {
  const active = sort.key === sortKey
  return (
    <th className={className} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="sort-button" onClick={() => onSort(sortKey)}>
        {label}
        <span className="sort-mark" aria-hidden="true">
          {active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  )
}
