import { Link } from 'react-router'
import { PageHead } from '../components/PageHead'

export function PlanPage() {
  return (
    <>
      <PageHead
        title="Plan"
        intro="What EMHASS wants the battery, grid and EV to do in each quarter-hour, and why. This page fills in once EMHASS Lens builds and runs the MPC itself."
      />
      <div className="phase">
        <section className="panel">
          <div className="panel-head">
            <h2>This slot</h2>
            <span className="muted">Phase 2</span>
          </div>
          <div className="panel-body">
            <ul>
              <li>Battery, grid, PV, curtailment and EV power EMHASS planned for the current quarter-hour.</li>
              <li>The exact values the inverter automation receives in the emhass_lens_plan_published event.</li>
              <li>Last run: when, how long, optimizer status and expected profit; countdown to the next run.</li>
            </ul>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Plan chart</h2>
            <span className="muted">Phase 1–2</span>
          </div>
          <div className="panel-body">
            <ul>
              <li>Battery state of charge and charge/discharge power over the whole horizon.</li>
              <li>Grid import/export, PV and load, with import and export prices on the same time axis.</li>
              <li>The previous plan as a ghost line, and a list of the slots that changed.</li>
            </ul>
          </div>
        </section>
      </div>
      <p className="muted" style={{ marginTop: 20 }}>
        Until then, every job EMHASS Lens runs is listed under <Link to="/runs">Runs</Link>, with its logs under{' '}
        <Link to="/logs">Logs</Link>.
      </p>
    </>
  )
}
