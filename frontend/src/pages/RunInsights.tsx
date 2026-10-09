import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import type { EmhassCheck, ExplainArtifact, InputsSnapshot, Issue, ParityReport } from '../api/types'
import { ChecksTable } from '../components/ChecksTable'
import { DerivedFacts, ExplainTable } from '../components/ExplainTable'
import { ParityView } from '../components/ParityView'
import { InputsView } from '../components/Readings'
import { ValidationList } from '../components/Validation'

function useArtifact<T>(runId: number, kind: string, enabled: boolean) {
  return useQuery({
    queryKey: ['artifact', runId, kind],
    queryFn: () => api.get<T>(`/api/runs/${runId}/artifacts/${encodeURIComponent(kind)}`),
    enabled,
    staleTime: Infinity,
  })
}

/** Readable views of the artifacts EMHASS Lens knows (MPC builds, parity, EMHASS checks). */
export function RunInsights({ runId, kinds }: { runId: number; kinds: string[] }) {
  const has = (k: string) => kinds.includes(k)
  const explain = useArtifact<ExplainArtifact>(runId, 'explain', has('explain'))
  const inputs = useArtifact<InputsSnapshot>(runId, 'inputs', has('inputs'))
  const validation = useArtifact<Issue[]>(runId, 'validation', has('validation'))
  const parity = useArtifact<ParityReport>(runId, 'parity', has('parity'))
  const checks = useArtifact<EmhassCheck[]>(runId, 'checks', has('checks'))

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
