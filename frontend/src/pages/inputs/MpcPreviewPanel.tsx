import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import type { MpcPreview } from '../../api/types'
import { DerivedFacts, ExplainTable } from '../../components/ExplainTable'
import { JsonViewer } from '../../components/JsonViewer'
import { ErrorNotice } from '../../components/PageHead'
import { InputsView } from '../../components/Readings'
import { ValidationList } from '../../components/Validation'
import { formatTime } from '../../lib/format'

/** Build the MPC payload as if a run started now, and show what would be sent and why. */
export function MpcPreviewPanel() {
  const preview = useMutation({ mutationFn: () => api.post<MpcPreview>('/api/mpc/preview') })
  const [raw, setRaw] = useState(false)
  const p = preview.data
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>MPC payload preview</h2>
        <button type="button" className="primary" disabled={preview.isPending} onClick={() => preview.mutate()}>
          {preview.isPending ? 'Building…' : p ? 'Build again' : 'Preview MPC payload'}
        </button>
      </div>
      <div className="panel-body">
        <ErrorNotice error={preview.error} />
        {!p && !preview.isPending && (
          <p className="muted" style={{ margin: 0 }}>
            Builds and checks the naive-mpc-optim payload as if a run started now. Nothing is sent to EMHASS.
          </p>
        )}
        {p && (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              Built at {formatTime(p.built_at)} in mode {p.mode.replace('_', ' ')}.
            </p>
            <h3 className="sub-head">Checks</h3>
            <ValidationList issues={p.validation} />
            <h3 className="sub-head">Derived values</h3>
            <DerivedFacts derived={p.derived} anchor={p.anchor} rounding={p.rounding} />
            <h3 className="sub-head">Inputs</h3>
            <InputsView snapshot={p.inputs} />
            <h3 className="sub-head">Explain: each position of the payload</h3>
            <ExplainTable slots={p.explain} />
            <div style={{ marginTop: 12 }}>
              <button type="button" className="quiet" aria-expanded={raw} onClick={() => setRaw((r) => !r)}>
                {raw ? '▾' : '▸'} Raw payload
              </button>
              {raw && <JsonViewer value={p.payload} openDepth={1} />}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
