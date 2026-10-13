import type { WearStats } from '../../api/types'

/** Presses of the Sofar apply and feed-in buttons: every one wears the EEPROM. */
export function WearFacts({ day, week }: { day: WearStats | undefined; week: WearStats | undefined }) {
  const line = (w: WearStats | undefined) =>
    w ? `${w.apply_presses} apply, ${w.feedin_presses} feed-in (${w.our_commits} by EMHASS Lens${w.presses_not_ours ? `, ${w.presses_not_ours} not ours` : ''})` : '—'
  return (
    <>
      <div>
        <dt>Inverter writes, 24 h</dt>
        <dd>{line(day)}</dd>
      </div>
      <div>
        <dt>Inverter writes, 7 days</dt>
        <dd>{line(week)}</dd>
      </div>
    </>
  )
}
