import type { SortState } from '../lib/sort'

/** A column header that sorts the table: click to sort by it, click again to flip the direction. */
export function SortableTh({
  label,
  sortKey,
  sort,
  onSort,
  className,
  title,
}: {
  label: string
  sortKey: string
  sort: SortState
  onSort: (key: string) => void
  className?: string
  /** Hover text ("Times in Europe/Tallinn"). */
  title?: string
}) {
  const active = sort.key === sortKey
  return (
    <th className={className} title={title} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="sort-button" onClick={() => onSort(sortKey)}>
        {label}
        <span className="sort-mark" aria-hidden="true">
          {active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  )
}
