import { dayChipLabel, dayLabel } from '../../lib/days'

/** Steps a day strip through `days` (oldest first): the day before, the day shown ("Thu 15", "Mon 19 · today"; back to
 *  today on a click when it isn't), the day after. */
export function DayChips({
  day,
  days,
  today,
  onChange,
}: {
  day: string
  days: string[]
  today: string
  onChange: (day: string) => void
}) {
  const i = days.indexOf(day)
  const before = i > 0 ? days[i - 1] : undefined
  const after = i >= 0 && i < days.length - 1 ? days[i + 1] : undefined
  return (
    <div className="segmented day-chips" role="group" aria-label="Day">
      <button
        type="button"
        disabled={!before}
        onClick={() => before && onChange(before)}
        aria-label={before ? `The day before: ${dayLabel(before)}` : 'No earlier day'}
      >
        ‹{before && ` ${dayChipLabel(before)}`}
      </button>
      <button
        type="button"
        aria-pressed="true"
        onClick={() => onChange(today)}
        title={day === today ? undefined : 'Back to today'}
      >
        {dayChipLabel(day)}
        {day === today && ' · today'}
      </button>
      <button
        type="button"
        disabled={!after}
        onClick={() => after && onChange(after)}
        aria-label={after ? `The day after: ${dayLabel(after)}` : 'No later day'}
      >
        {after && `${dayChipLabel(after)} `}›
      </button>
    </div>
  )
}
