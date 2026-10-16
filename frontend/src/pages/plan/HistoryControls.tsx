import { HORIZONS, VIEW_WINDOWS, WIDE_VIEWS, type HorizonSlots, type ViewHours } from '../../lib/planHistory'

/** How much time the charts show around now, and which earlier plan a past slot is compared with. A phone gets its
 *  own windows as three full-width buttons, and no comparison. */
export function HistoryControls({
  view,
  horizon,
  onView,
  onHorizon,
  windows = WIDE_VIEWS,
  narrow = false,
}: {
  view: ViewHours
  horizon: HorizonSlots
  onView: (view: ViewHours) => void
  onHorizon: (horizon: HorizonSlots) => void
  windows?: readonly ViewHours[]
  narrow?: boolean
}) {
  const shown = VIEW_WINDOWS.filter((w) => windows.includes(w.hours))
  if (narrow) {
    return (
      <div className="segmented history-windows" role="group" aria-label="How much time the charts show around now">
        {shown.map((w) => (
          <button key={w.hours} type="button" aria-pressed={w.hours === view} onClick={() => onView(w.hours)}>
            {w.hours === 48 ? '2 days' : w.label}
          </button>
        ))}
      </div>
    )
  }
  return (
    <div className="history-controls">
      <span>
        Window
        <div className="segmented" role="group" aria-label="How much time the charts show around now">
          {shown.map((w) => (
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
