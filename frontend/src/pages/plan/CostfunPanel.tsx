import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { api } from '../../api/client'
import { keys, useCostfun, useJobs, useStatus } from '../../api/queries'
import type { CostfunResult, RunStarted } from '../../api/types'
import { TimeChart, type ChartSeries } from '../../components/charts/TimeChart'
import { Empty, ErrorNotice } from '../../components/PageHead'
import { formatTime } from '../../lib/format'
import {
  cheapest,
  compareGrid,
  formatEur,
  formatKwh,
  isMethod,
  loadQuantity,
  loadShown,
  METHOD_COLOR,
  METHOD_EXPLAINED,
  METHOD_LABEL,
  METHODS,
  methodSeries,
  QUANTITIES,
  saveQuantity,
  saveShown,
  type Method,
  type QuantityKey,
} from '../../lib/costfun'
import { formatPower } from '../../lib/units'

const SOURCE: Record<string, string> = {
  settings: 'chosen under Settings → EMHASS → MPC',
  emhass_config: "from EMHASS's own configuration",
  assumed: 'assumed; EMHASS did not say',
}

function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${v.toFixed(0)} %`
}

/** EMHASS's three cost functions for the same inputs: a totals table, one chart to overlay them, and the trend. */
export function CostfunPanel({ nowS, now }: { nowS: number; now: Date }) {
  const data = useCostfun()
  const jobs = useJobs()
  const status = useStatus()
  const queryClient = useQueryClient()
  const writable = status.data?.writable ?? false
  const running = jobs.data?.some((j) => j.id === 'emhass.costfun_compare' && j.running) ?? false
  const compare = useMutation({
    mutationFn: () => api.post<RunStarted>('/api/jobs/emhass.costfun_compare/run', {}),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.jobs })
      void queryClient.invalidateQueries({ queryKey: ['runs'] })
    },
  })
  const [shown, setShown] = useState<Set<Method>>(loadShown)
  const [quantity, setQuantity] = useState<QuantityKey>(loadQuantity)
  useEffect(() => saveShown(shown), [shown])
  useEffect(() => saveQuantity(quantity), [quantity])
  const toggle = (m: Method) =>
    setShown((prev) => {
      const next = new Set(prev)
      if (next.has(m)) next.delete(m)
      else next.add(m)
      return next
    })

  const body = data.data
  const results = useMemo(() => body?.results ?? [], [body])
  const x = useMemo(() => compareGrid(results), [results])
  const series = useMemo<ChartSeries[]>(() => {
    const fmt = quantity === 'SOC_opt' ? (v: number) => `${v.toFixed(1)} %` : formatPower
    return results
      .filter((r): r is CostfunResult & { costfun: Method } => isMethod(r.costfun) && shown.has(r.costfun) && r.rows.length > 0)
      .map((r) => ({
        label: METHOD_LABEL[r.costfun] + (r.live ? ' (in use)' : ''),
        color: METHOD_COLOR[r.costfun],
        width: r.live ? 2.5 : 1.5,
        step: quantity !== 'SOC_opt',
        values: methodSeries(x, r, quantity),
        format: fmt,
      }))
  }, [results, shown, quantity, x])

  const live = body ? (isMethod(body.live_costfun) ? body.live_costfun : null) : null
  const best = cheapest(results)
  const busy = running || compare.isPending
  return (
    <>
      <div className="costfun-head">
        <div>
          {body && (
            <>
              In use: <strong>{live ? METHOD_LABEL[live] : body.live_costfun}</strong>{' '}
              <span className="muted">({SOURCE[body.live_source] ?? body.live_source})</span>
              {body.auto && <span className="muted"> · compared on every run</span>}
              {body.compared_at && (
                <span className="muted">
                  {' '}
                  · last compared {formatTime(body.compared_at, now, body.timezone)}
                  {body.run_id && (
                    <>
                      {' '}
                      (<Link to={`/runs/${body.run_id}`}>run #{body.run_id}</Link>)
                    </>
                  )}
                </span>
              )}
            </>
          )}
        </div>
        <div className="action-row" style={{ margin: 0 }}>
          <button
            type="button"
            className="primary"
            disabled={!writable || busy || !(body?.can_run ?? false)}
            title={
              body?.can_run === false
                ? `Can't compare now: ${body.cannot_run_reason}`
                : 'Runs EMHASS with the other two cost functions and then the one in use (three optimisations)'
            }
            onClick={() => compare.mutate()}
          >
            {busy ? 'Comparing…' : 'Compare now'}
          </button>
          <Link className="button" to="/settings?section=emhass">
            Settings
          </Link>
        </div>
      </div>
      <ErrorNotice error={data.error ?? compare.error} />
      {body?.can_run === false && <p className="chart-note">Can't compare right now: {body.cannot_run_reason}.</p>}
      {body && !body.available ? (
        <Empty title="Not compared yet">
          “Compare now” runs the MPC three times with the same inputs, once per cost function, and shows what each would
          do with the battery and the grid and what it would cost. The one in use runs last, so EMHASS keeps the real
          plan. Profit: {METHOD_EXPLAINED.profit}. Cost: {METHOD_EXPLAINED.cost}. Self-consumption:{' '}
          {METHOD_EXPLAINED['self-consumption']}.
        </Empty>
      ) : null}
      {results.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="num-table costfun-table">
              <thead>
                <tr>
                  <th>Method</th>
                  <th className="r">Net cost</th>
                  <th className="r">Import</th>
                  <th className="r">Export</th>
                  <th className="r">Self-consumption</th>
                  <th className="r">Battery charge / discharge</th>
                  <th className="r">End SOC</th>
                  <th className="r">EMHASS objective</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => {
                  const t = r.totals
                  const method = isMethod(r.costfun) ? r.costfun : null
                  return (
                    <tr key={r.costfun}>
                      <td className={r.live ? 'live' : undefined}>
                        {method ? METHOD_LABEL[method] : r.label}
                        {r.live && <span className="muted"> (in use)</span>}
                        <div className="cell-sub">{method ? METHOD_EXPLAINED[method] : ''}</div>
                      </td>
                      {t ? (
                        <>
                          <td className={`num r${best !== null && best === method ? ' best' : ''}`}>
                            {formatEur(t.net_cost_eur)}
                            <div className="cell-sub">
                              {formatEur(t.import_cost_eur)} − {formatEur(t.export_revenue_eur)}
                            </div>
                          </td>
                          <td className="num r">{formatKwh(t.import_kwh)}</td>
                          <td className="num r">{formatKwh(t.export_kwh)}</td>
                          <td className="num r">
                            {formatKwh(t.self_consumption_kwh)}
                            <div className="cell-sub">{pct(t.self_consumption_pct)} of PV</div>
                          </td>
                          <td className="num r">
                            {formatKwh(t.battery_charge_kwh)} / {formatKwh(t.battery_discharge_kwh)}
                          </td>
                          <td className="num r">{t.soc_end === null || t.soc_end === undefined ? '—' : `${(t.soc_end * 100).toFixed(0)} %`}</td>
                          <td className="num r">
                            {formatEur(t.emhass_objective)}
                            <div className="cell-sub">{t.emhass_objective_column ?? ''}</div>
                          </td>
                        </>
                      ) : (
                        <td colSpan={7} className="muted">
                          No plan: {r.problem ?? r.optim_status ?? 'unknown'}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="chart-note">
            Net cost, import, export and self-consumption are computed the same way for every plan over its{' '}
            {results[0]?.totals?.hours ?? '?'} h horizon, from each plan's grid power and the prices sent. EMHASS objective
            is the sum of the plan's own cost_fun column (EMHASS's sign: positive is money in), only comparable within one
            method.
          </p>

          <div className="costfun-toggles">
            <div className="segmented" role="group" aria-label="Quantity to compare">
              {QUANTITIES.map((q) => (
                <button key={q.key} type="button" aria-pressed={q.key === quantity} onClick={() => setQuantity(q.key)}>
                  {q.label}
                </button>
              ))}
            </div>
            {METHODS.map((m) => (
              <label key={m}>
                <input type="checkbox" checked={shown.has(m)} onChange={() => toggle(m)} />
                <span className="swatch" style={{ background: `var(${METHOD_COLOR[m]})` }} />
                {METHOD_LABEL[m]}
              </label>
            ))}
          </div>
          {series.length > 0 ? (
            <TimeChart
              x={x}
              series={series}
              ariaLabel="The compared plans' values per quarter-hour, one line per cost function"
              yFormat={quantity === 'SOC_opt' ? (v) => `${v.toFixed(0)} %` : (v) => `${(v / 1000).toFixed(1)} kW`}
              fit={quantity === 'SOC_opt' ? { minSpan: 5, clamp: [0, 100] } : { minSpan: 500 }}
              now={nowS}
              timeZone={body?.timezone}
              height={220}
            />
          ) : (
            <p className="chart-note">Tick a method above to draw it.</p>
          )}
        </>
      )}
      {body && body.history.length > 1 && (
        <>
          <h3 className="chart-block">Earlier comparisons (net cost over each plan's horizon)</h3>
          <div className="table-wrap">
            <table className="num-table costfun-table">
              <thead>
                <tr>
                  <th>Compared</th>
                  {METHODS.map((m) => (
                    <th key={m} className="r">
                      {METHOD_LABEL[m]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...body.history]
                  .reverse()
                  .slice(0, 16)
                  .map((p) => {
                    const values = METHODS.map((m) => p.net_cost_eur[m] ?? null)
                    const known = values.filter((v): v is number => v !== null)
                    const min = known.length > 1 ? Math.min(...known) : null
                    return (
                      <tr key={`${p.compared_at}-${p.anchor}`}>
                        <td className="num">
                          {p.run_id ? <Link to={`/runs/${p.run_id}`}>{formatTime(p.compared_at, now, body.timezone)}</Link> : formatTime(p.compared_at, now, body.timezone)}
                        </td>
                        {values.map((v, i) => (
                          <td key={METHODS[i]} className={`num r${min !== null && v === min ? ' best' : ''}`}>
                            {formatEur(v)}
                          </td>
                        ))}
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  )
}
