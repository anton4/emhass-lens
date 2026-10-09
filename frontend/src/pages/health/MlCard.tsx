import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useMlAction, type MlAction } from '../../api/actions'
import { useLatestRun, useSettings, useSettingsSchema, useStatus } from '../../api/queries'
import type { SklearnModel } from '../../api/types'
import { LabelledLamp } from '../../components/Lamp'
import { OutcomeChip } from '../../components/Outcome'
import { ErrorNotice } from '../../components/PageHead'
import { formatDuration, formatTime } from '../../lib/format'

const FALLBACK_MODELS: SklearnModel[] = [
  'KNeighborsRegressor',
  'RandomForestRegressor',
  'GradientBoostingRegressor',
  'RidgeRegression',
  'MLPRegressor',
]

const JOBS: { action: MlAction; title: string; what: string }[] = [
  { action: 'fit', title: 'Fit', what: 'Trains the load forecast model on the load sensor history (forecast-model-fit).' },
  { action: 'tune', title: 'Tune', what: 'Searches better model settings, then refits (forecast-model-tune). Slow.' },
  { action: 'predict', title: 'Predict', what: 'Publishes sensor.p_load_forecast_custom_model (forecast-model-predict).' },
]

/** EMHASS's ML load forecaster: run fit / tune / predict with the lag settings MPC uses. */
export function MlCard({ writable }: { writable: boolean }) {
  const settings = useSettings()
  const schema = useSettingsSchema()
  const status = useStatus()
  const ml = useMlAction()
  const navigate = useNavigate()
  const current = settings.data?.settings.emhass
  const models =
    (schema.data?.properties?.emhass?.properties?.ml?.properties?.sklearn_model?.enum as SklearnModel[] | undefined) ??
    FALLBACK_MODELS
  const [model, setModel] = useState<SklearnModel | ''>('')
  const [historicDays, setHistoricDays] = useState('')
  const [trials, setTrials] = useState('')
  const lagsChanged = status.data?.problems.find((p) => p.key === 'ml.lags_changed')

  const run = (action: MlAction) => {
    const params = {
      sklearn_model: action === 'predict' ? null : model || null,
      historic_days: action === 'predict' || historicDays === '' ? null : Number(historicDays),
      n_trials: action === 'tune' && trials !== '' ? Number(trials) : null,
    }
    ml.mutate(
      { action, params },
      { onSuccess: (started) => started.run_id && navigate(`/runs/${started.run_id}`) },
    )
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>ML load forecast</h2>
        {current && <span className="muted">model {current.ml.sklearn_model}, load sensor {current.ml.var_model}</span>}
      </div>
      <div className="panel-body">
        <p style={{ marginTop: 0 }}>
          EMHASS forecasts the household load with a model trained on your load sensor. EMHASS Lens runs it with the same
          number of lags as the MPC runs. Fit and tune can take long (time limits {current ? `${formatDuration(current.timeouts.fit * 1000)} and ${formatDuration(current.timeouts.tune * 1000)}` : 'from Settings → EMHASS → Timeouts'}); MPC runs wait while EMHASS is busy with them.
        </p>
        {lagsChanged && (
          <div className="notice" data-color="amber" role="note">
            <strong>{lagsChanged.title}.</strong> {lagsChanged.detail} Run Fit so the model matches.
          </div>
        )}
        <ErrorNotice error={ml.error} />
        <div className="ml-grid">
          <label>
            Model
            <select value={model} onChange={(e) => setModel(e.target.value as SklearnModel | '')} disabled={!writable}>
              <option value="">From settings{current ? ` (${current.ml.sklearn_model})` : ''}</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label>
            Training history (days)
            <input
              type="number"
              min={9}
              max={365}
              placeholder={current ? String(current.ml.historic_days) : '30'}
              value={historicDays}
              onChange={(e) => setHistoricDays(e.target.value)}
              disabled={!writable}
            />
          </label>
          <label>
            Tuning trials
            <input
              type="number"
              min={5}
              max={100}
              placeholder={current ? String(current.ml.n_trials) : '10'}
              value={trials}
              onChange={(e) => setTrials(e.target.value)}
              disabled={!writable}
            />
          </label>
        </div>
        <div className="ml-jobs">
          {JOBS.map((job) => (
            <MlJob key={job.action} {...job} writable={writable} busy={ml.isPending} onRun={() => run(job.action)} />
          ))}
        </div>
      </div>
    </section>
  )
}

function MlJob({
  action,
  title,
  what,
  writable,
  busy,
  onRun,
}: {
  action: MlAction
  title: string
  what: string
  writable: boolean
  busy: boolean
  onRun: () => void
}) {
  const last = useLatestRun(`ml.${action}`)
  const run = last.data
  return (
    <div className="ml-job">
      <div className="cell-title">{title}</div>
      <div className="cell-sub">{what}</div>
      <div className="action-row" style={{ marginTop: 10 }}>
        <button type="button" disabled={!writable || busy} onClick={onRun}>
          {title} now
        </button>
        {run ? (
          <Link to={`/runs/${run.id}`} className="cell-sub">
            <OutcomeChip outcome={run.outcome} /> {formatTime(run.started_at)}
          </Link>
        ) : (
          <LabelledLamp color="neutral" text="Never run" />
        )}
      </div>
    </div>
  )
}
