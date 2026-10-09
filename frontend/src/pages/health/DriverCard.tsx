import { useState } from 'react'
import { useHandBack, useTakeOver } from '../../api/actions'
import { useEmhass, useSettings, useStatus } from '../../api/queries'
import { DriverResultNotice, HandBackDialog, TakeOverDialog } from '../../components/DriverDialogs'
import { LabelledLamp } from '../../components/Lamp'
import { ErrorNotice } from '../../components/PageHead'
import { driverSpec } from '../../lib/driver'
import { formatTime } from '../../lib/format'

/** Who sends MPC runs to EMHASS: EMHASS Lens, the HACS integration, both (bad) or nobody, and the
 * one-step switches between EMHASS Lens and the HACS integration. */
export function DriverCard({ writable }: { writable: boolean }) {
  const status = useStatus()
  const emhass = useEmhass()
  const settings = useSettings()
  const takeOver = useTakeOver()
  const handBack = useHandBack()
  const [dialog, setDialog] = useState<'take-over' | 'hand-back' | null>(null)
  const driver = status.data?.driver ?? 'none'
  const mpc = emhass.data?.mpc
  const spec = driverSpec(driver)
  const legacySwitch = settings.data?.settings.parity.legacy_auto_mpc_switch
  const lensDrives = driver === 'app'
  const last = takeOver.data ? { result: takeOver.data, what: 'take over' as const } : handBack.data ? { result: handBack.data, what: 'hand back' as const } : null

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Driving EMHASS</h2>
        <LabelledLamp color={spec.color} text={spec.text} />
      </div>
      <div className="panel-body">
        <p style={{ marginTop: 0 }}>{spec.explain}</p>
        <ErrorNotice error={takeOver.error ?? handBack.error} />
        {last && <DriverResultNotice result={last.result} what={last.what} />}
        {mpc && (
          <dl className="facts">
            <div>
              <dt>EMHASS Lens mode</dt>
              <dd>{mpc.mode.replace('_', ' ')}</dd>
            </div>
            <div>
              <dt>Auto MPC</dt>
              <dd>{mpc.auto ? 'on' : 'off'}</dd>
            </div>
            <div>
              <dt>HACS integration Auto MPC</dt>
              <dd>{mpc.legacy_driving ? 'on' : 'off'}</dd>
            </div>
            <div>
              <dt>Last build</dt>
              <dd>{mpc.last_build ? `${mpc.last_build.horizon} slots, ${formatTime(mpc.last_build.built_at)}` : '—'}</dd>
            </div>
            <div>
              <dt>Last successful live run</dt>
              <dd>{formatTime(mpc.last_success_at)}</dd>
            </div>
          </dl>
        )}
        <div className="action-row">
          <button
            type="button"
            className={lensDrives ? undefined : 'primary'}
            disabled={!writable || lensDrives || takeOver.isPending}
            onClick={() => setDialog('take-over')}
            title={lensDrives ? 'EMHASS Lens already drives EMHASS' : undefined}
          >
            Take over
          </button>
          <button
            type="button"
            disabled={!writable || handBack.isPending || driver === 'legacy'}
            onClick={() => setDialog('hand-back')}
          >
            Hand back
          </button>
          {!writable && <span className="cell-sub">Open EMHASS Lens from the Home Assistant sidebar to switch.</span>}
        </div>
      </div>
      <TakeOverDialog
        open={dialog === 'take-over'}
        busy={takeOver.isPending}
        legacySwitch={legacySwitch}
        onClose={() => setDialog(null)}
        onConfirm={() => {
          handBack.reset()
          takeOver.mutate(undefined, { onSettled: () => setDialog(null) })
        }}
      />
      <HandBackDialog
        open={dialog === 'hand-back'}
        busy={handBack.isPending}
        onClose={() => setDialog(null)}
        onConfirm={() => {
          takeOver.reset()
          handBack.mutate(undefined, { onSettled: () => setDialog(null) })
        }}
      />
    </section>
  )
}
