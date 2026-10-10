import { shiftDay, todayKey } from '../lib/days'
import type { ListParams, ListPatch } from '../lib/listParams'

export interface FilterOption {
  value: string
  label: string
}

/** The toolbar above a list: which day (or the latest rows), a search, an optional filter and
 * "mismatches only". Sorting is on the column headers. */
export function ListControls({
  value,
  onChange,
  timeZone,
  filterLabel,
  filterOptions,
  mismatchLabel,
  searchLabel = 'Search',
  shown,
  latestLabel = 'Latest',
}: {
  value: ListParams
  onChange: (patch: ListPatch) => void
  timeZone?: string
  filterLabel?: string
  filterOptions?: FilterOption[]
  mismatchLabel?: string
  searchLabel?: string
  shown?: string
  latestLabel?: string
}) {
  const today = todayKey(timeZone)
  const day = value.day
  return (
    <div className="toolbar list-controls">
      <div className="day-picker" role="group" aria-label="Day">
        <button type="button" className="quiet" aria-pressed={!day} onClick={() => onChange({ day: '' })}>
          {latestLabel}
        </button>
        <button
          type="button"
          className="quiet"
          aria-label="Previous day"
          onClick={() => onChange({ day: shiftDay(day || today, -1) })}
        >
          ←
        </button>
        <label>
          <span className="visually-hidden">Day</span>
          <input type="date" value={day} max={today} onChange={(e) => onChange({ day: e.target.value })} />
        </label>
        <button
          type="button"
          className="quiet"
          aria-label="Next day"
          disabled={!day || day >= today}
          onClick={() => onChange({ day: shiftDay(day, 1) })}
        >
          →
        </button>
      </div>
      <label>
        <span className="visually-hidden">{searchLabel}</span>
        <input
          type="search"
          className="search"
          placeholder={searchLabel}
          value={value.q}
          onChange={(e) => onChange({ q: e.target.value })}
        />
      </label>
      {filterOptions && filterOptions.length > 0 && (
        <label>
          <span className="visually-hidden">{filterLabel}</span>
          <select value={value.filter} onChange={(e) => onChange({ filter: e.target.value })}>
            <option value="">{`All ${(filterLabel ?? 'kinds').toLowerCase()}`}</option>
            {filterOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {mismatchLabel && (
        <label className="check">
          <input type="checkbox" checked={value.mismatch} onChange={(e) => onChange({ mismatch: e.target.checked })} />
          {mismatchLabel}
        </label>
      )}
      {shown && <span className="muted">{shown}</span>}
    </div>
  )
}
