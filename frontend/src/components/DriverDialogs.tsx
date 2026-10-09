import { Link } from 'react-router'
import type { DriverResult } from '../api/types'
import { cutoverWarning } from '../lib/driver'
import { ConfirmDialog } from './ConfirmDialog'
import { LabelledLamp } from './Lamp'

/** Confirms "Take over": the HACS integration stops, EMHASS Lens goes live. */
export function TakeOverDialog({
  open,
  onClose,
  onConfirm,
  busy,
  legacySwitch,
  intro,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  busy: boolean
  legacySwitch?: string
  intro?: string
}) {
  const warning = open ? cutoverWarning(new Date()) : null
  return (
    <ConfirmDialog
      open={open}
      title="Take over from the HACS integration?"
      onClose={onClose}
      actions={[{ label: busy ? 'Taking over…' : 'Take over', kind: 'primary', onClick: onConfirm, disabled: busy }]}
    >
      {intro && <p>{intro}</p>}
      <p>In one step EMHASS Lens will:</p>
      <ul>
        <li>
          turn the HACS integration's Auto MPC switch off{legacySwitch ? <> (<code>{legacySwitch}</code>)</> : null} and
          check that it is off,
        </li>
        <li>switch EMHASS Lens to Live with Auto MPC on: from the next quarter-hour it sends the MPC runs to EMHASS and publishes the plan as each slot starts.</li>
      </ul>
      <p>Hand back puts everything back the other way at any time.</p>
      {warning && (
        <div className="notice" data-color="amber" role="note">
          {warning}
        </div>
      )}
    </ConfirmDialog>
  )
}

/** Confirms "Hand back": EMHASS Lens goes to dry run, the HACS integration drives again. */
export function HandBackDialog({
  open,
  onClose,
  onConfirm,
  busy,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  busy: boolean
}) {
  return (
    <ConfirmDialog
      open={open}
      title="Hand EMHASS back to the HACS integration?"
      onClose={onClose}
      actions={[{ label: busy ? 'Handing back…' : 'Hand back', kind: 'danger', onClick: onConfirm, disabled: busy }]}
    >
      <ul>
        <li>EMHASS Lens switches to Dry run: it keeps building and checking payloads every quarter-hour but sends nothing to EMHASS.</li>
        <li>The HACS integration's Auto MPC switch is turned on, so it runs MPC again from its next quarter-hour.</li>
      </ul>
      <p>Prices, parity checks and logs keep running in EMHASS Lens.</p>
    </ConfirmDialog>
  )
}

/** What a take-over / hand-back did, with a link to its run. */
export function DriverResultNotice({ result, what }: { result: DriverResult; what: 'take over' | 'hand back' }) {
  return (
    <div className="notice" data-color={result.ok ? 'green' : 'red'} role="status">
      <LabelledLamp
        color={result.ok ? 'green' : 'red'}
        text={result.ok ? (what === 'take over' ? 'EMHASS Lens drives EMHASS now' : 'Handed back to the HACS integration') : `Couldn't ${what}`}
      />
      <div className="cell-sub">
        {result.error && <>{result.error}. </>}
        {result.legacy_switch ? <>HACS integration Auto MPC switch: {result.legacy_switch}. </> : null}
        {result.ok && !result.legacy_switch ? <>The HACS integration's Auto MPC switch wasn't found. </> : null}
        {result.revision ? <>Settings revision {result.revision}. </> : null}
        {result.run_id ? <Link to={`/runs/${result.run_id}`}>Run #{result.run_id}</Link> : null}
      </div>
    </div>
  )
}
