import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '../api/client'
import type { EmhassCheck, ExplainArtifact, InputsSnapshot, Issue, ParityReport, PublishEvent } from '../api/types'
import { ChecksTable } from '../components/ChecksTable'
import { DerivedFacts, ExplainTable } from '../components/ExplainTable'
import { ParityView } from '../components/ParityView'
import { InputsView } from '../components/Readings'
import { ValidationList } from '../components/Validation'
import { PublishEventView } from '../components/PublishEventView'
import { AgreeHeadline, CallsList, CompareTable, DecisionView } from '../components/InverterViews'
import { ChargerDecisionView } from '../components/ChargerViews'
import { MarketDecisionView } from '../components/MarketViews'
import { MARKET_FIELD_LABELS, marketFieldValue, type MarketComparison, type MarketLast } from '../lib/market'
import type { DecisionArtifact, InverterCall, InverterComparison } from '../lib/inverter'
import {
  CHARGER_FIELD_LABELS,
  chargerFieldValue,
  type ChargerCall,
  type ChargerComparison,
  type ChargerDecisionArtifact,
} from '../lib/charger'
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
  const decision = useArtifact<DecisionArtifact>(runId, 'decision', has('decision'))
  const calls = useArtifact<InverterCall[]>(runId, 'calls', has('calls'))
  const readback = useArtifact<InverterComparison>(runId, 'readback', has('readback'))
  const comparison = useArtifact<InverterComparison>(runId, 'comparison', has('comparison'))
  const chargerDecision = useArtifact<ChargerDecisionArtifact>(runId, 'charger_decision', has('charger_decision'))
  const chargerCalls = useArtifact<ChargerCall[]>(runId, 'charger_calls', has('charger_calls'))
  const chargerReadback = useArtifact<ChargerComparison>(runId, 'charger_readback', has('charger_readback'))
  const chargerComparison = useArtifact<ChargerComparison>(runId, 'charger_comparison', has('charger_comparison'))
  const marketDecision = useArtifact<MarketLast>(runId, 'market_decision', has('market_decision'))
  const marketComparison = useArtifact<MarketComparison>(runId, 'market_comparison', has('market_comparison'))
  const notification = useArtifact<{ message: string; ok: boolean | null; error?: string; dry_run?: boolean; skipped?: string }>(
    runId,
    'notification',
    has('notification'),
  )
  const handback = useArtifact<InverterCall[]>(runId, 'handback_calls', has('handback_calls'))

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
      {decision.data && (
        <section className="panel">
          <div className="panel-head">
            <h2>Inverter decision</h2>
            <span className="muted">from {decision.data.source}</span>
          </div>
          <div className="panel-body">
            {decision.data.blocked && (
              <div className="notice" data-color="amber" role="note">
                Not in control: {decision.data.blocked}. Nothing was applied; this is what it would have set.
              </div>
            )}
            <DecisionView
              decision={decision.data.decision}
              values={decision.data.values}
              observedBefore={decision.data.observed_before}
            />
          </div>
        </section>
      )}
      {calls.data && (
        <section className="panel">
          <div className="panel-head">
            <h2>Applied to the inverter</h2>
            <span className="muted">Home Assistant service calls</span>
          </div>
          <CallsList calls={calls.data} />
        </section>
      )}
      {readback.data && (
        <section className="panel">
          <div className="panel-head">
            <h2>Read back</h2>
            <AgreeHeadline comparison={readback.data} what="The inverter shows the targets" />
          </div>
          <CompareTable comparison={readback.data} observedLabel="Inverter shows" />
        </section>
      )}
      {comparison.data && (
        <section className="panel">
          <div className="panel-head">
            <h2>Compared with the automation</h2>
            {comparison.data.decision_run_id !== undefined && (
              <Link to={`/runs/${comparison.data.decision_run_id}`}>decision run {comparison.data.decision_run_id}</Link>
            )}
          </div>
          <div className="panel-body">
            <p style={{ marginTop: 0 }}>
              <AgreeHeadline comparison={comparison.data} what="Automation vs EMHASS Lens" />
            </p>
            <CompareTable comparison={comparison.data} />
          </div>
        </section>
      )}
      {chargerDecision.data && (
        <section className="panel">
          <div className="panel-head">
            <h2>Charger decision</h2>
            <span className="muted">
              {chargerDecision.data.trigger.replace('_', ' ')} · EV power from {chargerDecision.data.source}
            </span>
          </div>
          <div className="panel-body">
            {chargerDecision.data.blocked && (
              <div className="notice" data-color="amber" role="note">
                Not in control: {chargerDecision.data.blocked}. Nothing was done; this is what it would have done.
              </div>
            )}
            <ChargerDecisionView
              decision={chargerDecision.data.decision}
              inputs={chargerDecision.data.inputs}
              observedBefore={chargerDecision.data.observed_before}
            />
          </div>
        </section>
      )}
      {chargerCalls.data && (
        <section className="panel">
          <div className="panel-head">
            <h2>{chargerCalls.data.some((c) => c.dry_run) ? 'Would call' : 'Applied to the charger'}</h2>
            <span className="muted">Home Assistant service calls</span>
          </div>
          <CallsList calls={chargerCalls.data} nothing="No calls." />
        </section>
      )}
      {chargerReadback.data && (
        <section className="panel">
          <div className="panel-head">
            <h2>Read back</h2>
            <AgreeHeadline comparison={chargerReadback.data} what="The charger shows the target" />
          </div>
          <CompareTable
            comparison={chargerReadback.data}
            observedLabel="Charger shows"
            labels={CHARGER_FIELD_LABELS}
            format={chargerFieldValue}
          />
        </section>
      )}
      {chargerComparison.data && (
        <section className="panel">
          <div className="panel-head">
            <h2>Compared with the automation</h2>
            {chargerComparison.data.decision_run_id !== undefined && (
              <Link to={`/runs/${chargerComparison.data.decision_run_id}`}>
                decision run {chargerComparison.data.decision_run_id}
              </Link>
            )}
          </div>
          <div className="panel-body">
            {chargerComparison.data.unexpected ? (
              <p style={{ marginTop: 0 }}>
                The automation set the current limit from {chargerComparison.data.unexpected.from} A to{' '}
                {chargerComparison.data.unexpected.to} A while EMHASS Lens had decided nothing.
              </p>
            ) : (
              <>
                <p style={{ marginTop: 0 }}>
                  <AgreeHeadline comparison={chargerComparison.data} what="Automation vs EMHASS Lens" />
                </p>
                <CompareTable comparison={chargerComparison.data} labels={CHARGER_FIELD_LABELS} format={chargerFieldValue} />
              </>
            )}
          </div>
        </section>
      )}
      {marketDecision.data && (
        <section className="panel">
          <div className="panel-head">
            <h2>Market decision</h2>
            <span className="muted">trigger {marketDecision.data.trigger}</span>
          </div>
          <div className="panel-body">
            {marketDecision.data.blocked && (
              <div className="notice" data-color="amber" role="note">
                Not in control: {marketDecision.data.blocked}. Nothing was written; this is what it would have done.
              </div>
            )}
            <MarketDecisionView decision={marketDecision.data.decision} sessionBefore={marketDecision.data.session_before} />
          </div>
        </section>
      )}
      {notification.data && (
        <section className="panel">
          <div className="panel-head">
            <h2>Phone message</h2>
            <span className="muted">
              {notification.data.ok ? 'sent' : notification.data.ok === null ? (notification.data.dry_run ? 'not sent (dry run)' : (notification.data.skipped ?? 'not sent')) : `failed: ${notification.data.error ?? ''}`}
            </span>
          </div>
          <div className="panel-body">“{notification.data.message}”</div>
        </section>
      )}
      {handback.data && (
        <section className="panel">
          <div className="panel-head">
            <h2>Hand-back</h2>
            <span className="muted">session select and the EMHASS automation switch</span>
          </div>
          <CallsList calls={handback.data} nothing="Nothing to change." />
        </section>
      )}
      {marketComparison.data && (
        <section className="panel">
          <div className="panel-head">
            <h2>Compared with the automation</h2>
            {marketComparison.data.decision_run_id !== undefined && (
              <Link to={`/runs/${marketComparison.data.decision_run_id}`}>decision run {marketComparison.data.decision_run_id}</Link>
            )}
          </div>
          <div className="panel-body">
            <p style={{ marginTop: 0 }}>
              <AgreeHeadline comparison={marketComparison.data} what="Automation vs EMHASS Lens" />
            </p>
            <CompareTable comparison={marketComparison.data} observedLabel="Home Assistant shows" labels={MARKET_FIELD_LABELS} format={marketFieldValue} />
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
