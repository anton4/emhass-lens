import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import type { EmhassCheck, ExplainArtifact, InputsSnapshot, Issue, ParityReport, PublishEvent } from '../api/types'
import { ChecksTable } from '../components/ChecksTable'
import { DerivedFacts, ExplainTable } from '../components/ExplainTable'
import { ParityView } from '../components/ParityView'
import { InputsView } from '../components/Readings'
import { ValidationList } from '../components/Validation'
import { PublishEventView } from '../components/PublishEventView'
import { formatDuration } from '../lib/format'

function useArtifact<T>(runId: number, kind: string, enabled: boolean) {
  return useQuery({
    queryKey: ['artifact', runId, kind],
    queryFn: () => api.get<T>(`/api/runs/${runId}/artifacts/${encodeURIComponent(kind)}`),
    enabled,
    staleTime: Infinity,
  })
}

/** The `response` artifact of runs that called an EMHASS action. */
interface ActionResponse {
  http_status: number | null
  duration_ms: number | null
  error: string | null
  error_lines?: string[]
  body?: string
}

/** Readable views of the artifacts EMHASS Lens knows (MPC builds, publishing, parity, EMHASS checks). */
export function RunInsights({ runId, job, kinds }: { runId: number; job: string; kinds: string[] }) {
  const has = (k: string) => kinds.includes(k)
  const explain = useArtifact<ExplainArtifact>(runId, 'explain', has('explain'))
  const inputs = useArtifact<InputsSnapshot>(runId, 'inputs', has('inputs'))
  const validation = useArtifact<Issue[]>(runId, 'validation', has('validation'))
  const parity = useArtifact<ParityReport>(runId, 'parity', has('parity'))
  const checks = useArtifact<EmhassCheck[]>(runId, 'checks', has('checks'))
  const event = useArtifact<PublishEvent>(runId, 'event', has('event'))
  const response = useArtifact<ActionResponse>(runId, 'response', has('response'))

  return (
    <>
      {(has('validation') || has('explain') || has('inputs')) && (
        <section className="panel">
          <div className="panel-head">
            <h2>MPC payload</h2>
            <span className="muted">What was checked, what it was built from, and what each position means</span>
          </div>
          <div className="panel-body">
            {validation.data && (
              <>
                <h3 className="sub-head" style={{ marginTop: 0 }}>
                  Checks
                </h3>
                <ValidationList issues={validation.data} />
              </>
            )}
            {explain.data && (
              <>
                <h3 className="sub-head">Derived values</h3>
                <DerivedFacts derived={explain.data.derived} anchor={explain.data.anchor} rounding={explain.data.rounding} />
              </>
            )}
            {inputs.data && (
              <>
                <h3 className="sub-head">Inputs</h3>
                <InputsView snapshot={inputs.data} />
              </>
            )}
            {explain.data && (
              <details className="explain-details">
                <summary>
                  <h3 className="sub-head" style={{ display: 'inline' }}>
                    Explain: {explain.data.slots.length} positions
                  </h3>
                </summary>
                <ExplainTable slots={explain.data.slots} />
              </details>
            )}
          </div>
        </section>
      )}
      {event.data && (
        <section className="panel">
          <div className="panel-head">
            <h2>Published to Home Assistant</h2>
            <span className="muted">
              event <code>emhass_lens_plan_published</code>
            </span>
          </div>
          <div className="panel-body">
            <PublishEventView event={event.data} />
          </div>
        </section>
      )}
      {response.data && <ResponsePanel job={job} response={response.data} />}
      {parity.data && (
        <section className="panel">
          <div className="panel-head">
            <h2>Parity report</h2>
          </div>
          <div className="panel-body">
            <ParityView report={parity.data} />
          </div>
        </section>
      )}
      {checks.data && (
        <section className="panel">
          <div className="panel-head">
            <h2>EMHASS configuration checks</h2>
          </div>
          <ChecksTable checks={checks.data} />
        </section>
      )}
    </>
  )
}

const ACTIONS: Record<string, string> = {
  'emhass.mpc': 'naive-mpc-optim',
  'emhass.publish': 'publish-data',
  'ml.fit': 'forecast-model-fit',
  'ml.tune': 'forecast-model-tune',
  'ml.predict': 'forecast-model-predict',
}

/** What EMHASS answered to the action this run sent. */
function ResponsePanel({ job, response }: { job: string; response: ActionResponse }) {
  const ok = !response.error
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>EMHASS response</h2>
        {ACTIONS[job] && (
          <span className="muted">
            POST /action/<code>{ACTIONS[job]}</code>
          </span>
        )}
      </div>
      <div className="panel-body">
        <dl className="facts">
          <div>
            <dt>Result</dt>
            <dd>{ok ? 'Accepted' : response.error}</dd>
          </div>
          <div>
            <dt>HTTP status</dt>
            <dd>{response.http_status ?? 'no answer'}</dd>
          </div>
          <div>
            <dt>Took</dt>
            <dd>{formatDuration(response.duration_ms)}</dd>
          </div>
        </dl>
        {response.error_lines && response.error_lines.length > 0 && (
          <>
            <h3 className="sub-head">Error lines from EMHASS's log</h3>
            <pre className="error-box">{response.error_lines.join('\n')}</pre>
          </>
        )}
        {response.body && (
          <details>
            <summary>Response body</summary>
            <pre className="log-exc">{response.body}</pre>
          </details>
        )}
      </div>
    </section>
  )
}
