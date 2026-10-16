import { HORIZONS, VIEW_WINDOWS, type HorizonSlots, type ViewHours } from '../../lib/planHistory'

/** How much time the charts show around now, and which earlier plan a past slot is compared with. */
export function HistoryControls({
  view,
  horizon,
  onView,
  onHorizon,
}: {
  view: ViewHours
  horizon: HorizonSlots
  onView: (view: ViewHours) => void
  onHorizon: (horizon: HorizonSlots) => void
}) {
  return (
    <div className="history-controls">
      <span>
        Window
        <div className="segmented" role="group" aria-label="How much time the charts show around now">
          {VIEW_WINDOWS.map((w) => (
            <button key={w.hours} type="button" aria-pressed={w.hours === view} onClick={() => onView(w.hours)}>
              {w.label}
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
