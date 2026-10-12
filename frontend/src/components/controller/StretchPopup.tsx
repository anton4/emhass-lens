import { stretchText, type Stretch } from '../../lib/dayStrip'
import { formatClock } from '../../lib/format'

/** One mark of the charger's or the market's day strip: when its decisions were made, what they were, and how they
 *  compared with the automation. */
export function StretchPopup({ stretch, timeZone }: { stretch: Stretch; timeZone?: string }) {
  const clock = (t: number) => formatClock(new Date(t * 1000).toISOString(), timeZone).slice(0, 5)
  const from = clock(stretch.from)
  const last = clock(stretch.last)
  return (
    <div className="slot-pop">
      <div className="slot-pop-head">
        <span className="slot-pop-time">{from === last ? from : `${from}–${last}`}</span>
      </div>
      {stretch.title && (
        <div className="slot-pop-state">
          <strong>{stretch.title}</strong>
        </div>
      )}
      <p className="slot-pop-note">{stretchText(stretch)}</p>
    </div>
  )
}
