import { Link } from 'react-router'
import { useSetup } from '../../api/queries'
import type { SetupStep } from '../../api/types'
import { LabelledLamp, type LampColor } from '../../components/Lamp'
import { ErrorNotice } from '../../components/PageHead'

const TODO = { color: 'neutral' as LampColor, text: 'To do' }
const STATE: Record<string, { color: LampColor; text: string }> = {
  done: { color: 'green', text: 'Done' },
  attention: { color: 'amber', text: 'Needs attention' },
  todo: TODO,
  skipped: { color: 'neutral', text: 'Not needed' },
}

function StepRow({ step }: { step: SetupStep }) {
  const state = STATE[step.state] ?? TODO
  const target = step.link?.startsWith('#') ? step.link.slice(1) : step.link
  return (
    <li className="setup-step">
      <LabelledLamp color={state.color} text={state.text} />
      <div>
        <strong>{step.title}</strong>
        {step.optional && <span className="muted"> (optional)</span>}
        <div className="cell-sub">
          {step.detail}
          {target && (
            <>
              {' · '}
              <Link to={target}>open</Link>
            </>
          )}
        </div>
      </div>
    </li>
  )
}

/** Getting started: the steps from the HACS integration to EMHASS Lens driving EMHASS. */
export function SetupCard() {
  const setup = useSetup()
  const data = setup.data
  const complete = data ? data.done >= data.total : false
  return (
    <section className="panel">
      <details open={!complete}>
        <summary className="panel-head setup-summary">
          <h2>Getting started</h2>
          <span className="muted">{data ? `${data.done} of ${data.total} done` : 'Checking…'}</span>
        </summary>
        <div className="panel-body">
          <ErrorNotice error={setup.error} />
          <p className="cell-sub" style={{ marginTop: 0 }}>
            Move over from the HACS integration step by step: keep the mode Off and compare for a while, then Dry run,
            then Take over. Every step can be undone with Hand back.
          </p>
          <ol className="setup-steps">
            {data?.steps.map((step) => <StepRow key={step.key} step={step} />)}
          </ol>
        </div>
      </details>
    </section>
  )
}
