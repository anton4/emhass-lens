import { HISTORY_WINDOWS, HORIZONS, windowLabel, type HistoryHours, type HorizonSlots } from '../../lib/planHistory'

/** How far back the charts reach, and which earlier plan a past slot is compared with. */
export function HistoryControls({
  hours,
  horizon,
  onHours,
  onHorizon,
}: {
  hours: HistoryHours
  horizon: HorizonSlots
  onHours: (hours: HistoryHours) => void
  onHorizon: (horizon: HorizonSlots) => void
}) {
  return (
    <div className="history-controls">
      <span>
        History
        <div className="segmented" role="group" aria-label="How far back to show">
          {HISTORY_WINDOWS.map((h) => (
            <button key={h} type="button" aria-pressed={h === hours} onClick={() => onHours(h)}>
              {windowLabel(h)}
            </button>
          ))}
        </div>
      </span>
      <span>
        Compare with
        <div className="segmented" role="group" aria-label="Which plan a past slot is compared with">
          {HORIZONS.map((h) => (
            <button key={h.slots} type="button" aria-pressed={h.slots === horizon} onClick={() => onHorizon(h.slots)}>
              {h.label}
            </button>
          ))}
        </div>
      </span>
    </div>
  )
}
