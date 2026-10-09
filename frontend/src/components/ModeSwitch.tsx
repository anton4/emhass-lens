import { Lamp, type LampColor } from './Lamp'

const POSITIONS: { id: string; text: string; color: LampColor }[] = [
  { id: 'off', text: 'OFF', color: 'neutral' },
  { id: 'dry_run', text: 'DRY RUN', color: 'blue' },
  { id: 'live', text: 'LIVE', color: 'green' },
]

/** The EMHASS mode as a three-position selector with the active position lit. Display only;
 * the mode is changed in Settings → EMHASS. */
export function ModeSwitch({ mode }: { mode: string | undefined }) {
  const active = POSITIONS.find((p) => p.id === mode)
  return (
    <div className="mode" role="img" aria-label={`EMHASS mode: ${active?.text.toLowerCase() ?? 'unknown'}`}>
      {POSITIONS.map((pos) => {
        const on = pos.id === mode
        return (
          <span key={pos.id} className="mode-pos" data-pos={pos.id} data-active={on} aria-hidden="true">
            <Lamp color={pos.color} lit={on} />
            {pos.text}
          </span>
        )
      })}
    </div>
  )
}
