import { useEmhass, useStatus } from '../../api/queries'
import type { MpcStatus } from '../../api/types'
import { LabelledLamp } from '../../components/Lamp'
import { driverSpec } from '../../lib/driver'
import { formatTime } from '../../lib/format'

/** Who sends MPC runs to EMHASS: EMHASS Lens, the HACS integration, both (bad) or nobody. */
export function DriverCard() {
  const status = useStatus()
  const emhass = useEmhass()
  const driver = status.data?.driver ?? 'none'
  const mpc = emhass.data?.mpc as unknown as MpcStatus | undefined
  const spec = driverSpec(driver)
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Driving EMHASS</h2>
        <LabelledLamp color={spec.color} text={spec.text} />
      </div>
      <div className="panel-body">
        <p style={{ marginTop: 0 }}>{spec.explain}</p>
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
              <dd>
                {mpc.last_build ? `${mpc.last_build.horizon} slots, ${formatTime(mpc.last_build.built_at)}` : '—'}
              </dd>
            </div>
            <div>
              <dt>Last successful live run</dt>
              <dd>{formatTime(mpc.last_success_at)}</dd>
            </div>
          </dl>
        )}
        <p className="cell-sub" style={{ marginBottom: 0 }}>
          Taking over from the HACS integration (and handing back) arrives with live mode in Phase 2.
        </p>
      </div>
    </section>
  )
}
