import { useState } from 'react'
import { useSetMode, useTakeOver, type EmhassMode } from '../api/actions'
import { useSettings } from '../api/queries'
import { ConfirmDialog } from './ConfirmDialog'
import { DriverResultNotice, TakeOverDialog } from './DriverDialogs'
import { Lamp, type LampColor } from './Lamp'

const POSITIONS: { id: EmhassMode; text: string; name: string; color: LampColor }[] = [
  { id: 'off', text: 'OFF', name: 'Off', color: 'neutral' },
  { id: 'dry_run', text: 'DRY RUN', name: 'Dry run', color: 'blue' },
  { id: 'live', text: 'LIVE', name: 'Live', color: 'green' },
]

const EXPLAIN: Record<EmhassMode, string> = {
  off: 'EMHASS Lens keeps prices and forecasts up to date and builds a shadow payload every quarter-hour, but never calls EMHASS.',
  dry_run:
    'Every quarter-hour EMHASS Lens builds and checks the MPC payload and runs every check a live run would (EMHASS reachable, configuration, nobody else driving), but sends nothing.',
  live: 'EMHASS Lens sends the MPC payload to EMHASS, checks the plan that comes back and publishes it as each slot starts.',
}

/** The EMHASS mode as a three-position selector with the active position lit. Choosing another
 * position asks for confirmation; going Live while the HACS integration drives EMHASS recommends
 * "Take over" instead, because live runs would be refused. */
export function ModeSwitch({
  mode,
  writable = false,
  driver,
  safeMode = false,
}: {
  mode: string | undefined
  writable?: boolean
  driver?: string
  safeMode?: boolean
}) {
  const [target, setTarget] = useState<EmhassMode | null>(null)
  const [takeOverOpen, setTakeOverOpen] = useState(false)
  const setMode = useSetMode()
  const takeOver = useTakeOver()
  const settings = useSettings()
  const active = POSITIONS.find((p) => p.id === mode)
  const enabled = writable && !safeMode
  const legacyDrives = driver === 'legacy' || driver === 'both'
  const auto = settings.data?.settings.emhass.mpc.auto
  const why = safeMode
    ? 'Safe mode is on: EMHASS mode is forced off'
    : !writable
      ? 'Read-only: open EMHASS Lens from the Home Assistant sidebar to change the mode'
      : undefined

  const close = () => {
    setTarget(null)
    setMode.reset()
  }
  const apply = (next: EmhassMode) => setMode.mutate(next, { onSuccess: close })
  const chosen = POSITIONS.find((p) => p.id === target)

  return (
    <>
      <div className="mode" role="radiogroup" aria-label="EMHASS mode">
        {POSITIONS.map((pos) => {
          const on = pos.id === mode
          return (
            <button
              key={pos.id}
              type="button"
              role="radio"
              aria-checked={on}
              className="mode-pos"
              data-pos={pos.id}
              data-active={on}
              disabled={!enabled || on}
              title={why ?? (on ? `EMHASS mode: ${pos.name}` : `Switch EMHASS mode to ${pos.name}`)}
              onClick={() => setTarget(pos.id)}
            >
              <Lamp color={pos.color} lit={on} />
              {pos.text}
            </button>
          )
        })}
        <span className="visually-hidden">Current mode: {active?.name ?? 'unknown'}</span>
      </div>

      {target === 'live' && legacyDrives ? (
        <ConfirmDialog
          open
          title="The HACS integration still drives EMHASS"
          onClose={close}
          actions={[
            { label: 'Switch to Live anyway', kind: 'quiet', onClick: () => apply('live'), disabled: setMode.isPending },
            {
              label: 'Take over instead',
              kind: 'primary',
              onClick: () => {
                close()
                setTakeOverOpen(true)
              },
            },
          ]}
        >
          <p>
            Its Auto MPC switch is on. In Live mode EMHASS Lens refuses to run while it is, so two planners never send runs
            to EMHASS at the same time.
          </p>
          <p>
            <strong>Take over</strong> turns the integration's Auto MPC off and switches EMHASS Lens to Live with Auto MPC on,
            in one step.
          </p>
          {setMode.error && <div className="notice" data-color="red">{(setMode.error as Error).message}</div>}
        </ConfirmDialog>
      ) : (
        <ConfirmDialog
          open={target !== null}
          title={`Switch EMHASS mode to ${chosen?.name ?? ''}?`}
          onClose={close}
          actions={[
            {
              label: setMode.isPending ? 'Switching…' : `Switch to ${chosen?.name ?? ''}`,
              kind: target === 'live' ? 'primary' : undefined,
              onClick: () => target && apply(target),
              disabled: setMode.isPending,
            },
          ]}
        >
          {target && <p>{EXPLAIN[target]}</p>}
          {target === 'live' && auto === false && (
            <p>
              Auto MPC is off, so scheduled runs stay shadow builds; only "Run MPC now" sends a run. Turn Auto MPC on in
              Settings → EMHASS, or use Take over on the Health page.
            </p>
          )}
          <p className="cell-sub">The change is stored as a settings revision and can be reverted from Settings → History.</p>
          {setMode.error && <div className="notice" data-color="red">{(setMode.error as Error).message}</div>}
        </ConfirmDialog>
      )}

      <TakeOverDialog
        open={takeOverOpen && !takeOver.data}
        busy={takeOver.isPending}
        legacySwitch={settings.data?.settings.parity.legacy_auto_mpc_switch}
        onClose={() => {
          setTakeOverOpen(false)
          takeOver.reset()
        }}
        onConfirm={() => takeOver.mutate()}
      />
      {takeOverOpen && takeOver.data && (
        <ConfirmDialog
          open
          title={takeOver.data.ok ? 'Taken over' : "Couldn't take over"}
          onClose={() => {
            setTakeOverOpen(false)
            takeOver.reset()
          }}
          cancelLabel="Close"
          actions={[]}
        >
          <DriverResultNotice result={takeOver.data} what="take over" />
        </ConfirmDialog>
      )}
    </>
  )
}
