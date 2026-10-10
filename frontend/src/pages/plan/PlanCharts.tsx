import { useMemo, useState } from 'react'
import type { PlanHistoryResponse, PlanPrice, PlanResponse, PlanRow } from '../../api/types'
import { TimeChart, type ChartSeries } from '../../components/charts/TimeChart'
import { snapWindow } from '../../lib/chartRange'
import { alignTo, deferrableColumns, hasColumn, socColumns } from '../../lib/plan'
import {
  deferrableFuture,
  hasMeasured,
  hasPlanned,
  mergePrices,
  pastAndFuture,
  pastEnd,
  pastShade,
  plannedAtTheTime,
  timeGrid,
} from '../../lib/planHistory'
import { eurTick, formatPower, formatPrice } from '../../lib/units'

const SYNC = 'plan'

// Each y-axis hugs its own data; the minimum spans keep near-flat lines from turning into noise.
const POWER_FIT = { minSpan: 500 }
const SOC_FIT = { minSpan: 5, clamp: [0, 100] as [number, number] }
const PRICE_FIT = { minSpan: 0.01 } // €/kWh

const windowFormats = new Map<string, Intl.DateTimeFormat>()
function windowLabel([a, b]: [number, number], timeZone?: string): string {
  const key = timeZone ?? ''
  let fmt = windowFormats.get(key)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(undefined, { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    windowFormats.set(key, fmt)
  }
  return `${fmt.format(new Date(a * 1000))} – ${fmt.format(new Date(b * 1000))}`
}

function kwTick(v: number): string {
  return `${(v / 1000).toFixed(Math.abs(v) < 10_000 ? 1 : 0)} kW`
}

/** Contiguous forecast ranges of plan prices (unix seconds). */
function forecastBands(prices: PlanPrice[]): [number, number][] {
  const out: [number, number][] = []
  for (const p of prices) {
    if (p.origin === 'actual') continue
    const start = Date.parse(p.start) / 1000
    const last = out[out.length - 1]
    if (last && last[1] === start) last[1] = start + 900
    else out.push([start, start + 900])
  }
  return out
}

// Power quantities in fixed slot order: battery, grid, PV, load (the deferrable loads follow).
const POWER = [
  { column: 'P_batt', measured: 'batt', planned: 'P_batt', label: 'Battery (+ discharge)', color: '--series-1' },
  { column: 'P_grid', measured: 'grid', planned: 'P_grid', label: 'Grid (+ import)', color: '--series-2' },
  { column: 'P_PV', measured: 'pv', planned: 'P_PV', label: 'PV', color: '--series-3' },
  { column: 'P_Load', measured: 'load', planned: 'P_Load', label: 'House load', color: '--series-4' },
] as const

const DASHED = { width: 1.5, dash: [4, 4] as number[] }

/** Power, state of charge and prices on one synced time axis: measured history (solid) with what the plan
 *  said at the time (dashed) left of the now line, the current plan right of it. */
export function PlanCharts({ data, history, nowS }: { data: PlanResponse; history?: PlanHistoryResponse; nowS: number }) {
  // One zoom window for all three charts (unix seconds); null shows the whole range
  const [zoom, setZoom] = useState<[number, number] | null>(null)
  const zoomTo = (range: [number, number] | null) => setZoom(range && snapWindow(range, 900))
  const currentRows = data.current?.rows
  const previousRows = data.previous?.rows
  const rows = useMemo(() => (currentRows ?? []) as PlanRow[], [currentRows])
  const previous = useMemo(() => (previousRows ?? []) as PlanRow[], [previousRows])
  const past = useMemo(() => history?.slots ?? [], [history])
  const pastEndS = pastEnd(past, nowS)
  const x = useMemo(() => timeGrid(past, rows), [past, rows])
  const shade = useMemo(() => pastShade(x, pastEndS), [x, pastEndS])

  const power = useMemo(() => {
    const series: ChartSeries[] = []
    for (const q of POWER) {
      const inPlan = hasColumn(rows, q.column)
      const measured = hasMeasured(past, q.measured)
      const planned = hasPlanned(past, q.planned)
      if (!inPlan && !measured && !planned) continue
      series.push({
        label: q.label,
        color: q.color,
        values: pastAndFuture(x, past, q.measured, rows, q.column, pastEndS),
        format: formatPower,
      })
      if (planned) {
        series.push({
          label: `${q.label}, planned at the time`,
          color: q.color,
          ...DASHED,
          values: plannedAtTheTime(x, past, q.planned),
          format: formatPower,
        })
      }
    }
    const deferrables = deferrableColumns(data.columns)
    const plannedDeferrable = hasPlanned(past, 'P_deferrable')
    if (deferrables.length > 0 || plannedDeferrable) {
      const label = deferrables.length === 1 ? 'Deferrable load' : 'Deferrable loads'
      series.push({
        label,
        color: '--series-5',
        values: deferrableFuture(x, rows, deferrables, pastEndS),
        format: formatPower,
      })
      if (plannedDeferrable) {
        series.push({
          label: `${label}, planned at the time`,
          color: '--series-5',
          ...DASHED,
          values: plannedAtTheTime(x, past, 'P_deferrable'),
          format: formatPower,
        })
      }
    }
    return series
  }, [x, rows, past, pastEndS, data.columns])

  const soc = useMemo(() => {
    const columns = socColumns(data.columns).filter((c) => hasColumn(rows, c))
    const plannedSoc = hasPlanned(past, 'SOC')
    if (columns.length === 0 && !plannedSoc && !hasMeasured(past, 'soc')) return null
    const fmt = (v: number) => `${v.toFixed(1)} %`
    const series: ChartSeries[] = []
    const first = columns[0] ?? 'SOC_opt'
    series.push({
      label: columns.length > 1 ? 'Battery 1 SOC' : 'Battery SOC',
      color: '--series-1',
      step: false,
      values: pastAndFuture(x, past, 'soc', rows, first, pastEndS, 100, false),
      format: fmt,
    })
    if (plannedSoc) {
      series.push({
        label: columns.length > 1 ? 'Battery 1, planned at the time' : 'Planned at the time',
        color: '--series-1',
        ...DASHED,
        step: false,
        values: plannedAtTheTime(x, past, 'SOC', 100, false),
        format: fmt,
      })
    }
    columns.slice(1).forEach((column, i) => {
      series.push({
        label: `Battery ${i + 2} SOC`,
        color: `--series-${i + 2}`,
        step: false,
        values: pastAndFuture(x, past, null, rows, column, pastEndS, 100, false),
        format: fmt,
      })
    })
    if (previous.length > 0) {
      const pct = (v: number | null) => (v === null ? null : v * 100)
      series.push({
        label: columns.length > 1 ? 'Battery 1, previous plan' : 'Previous plan',
        color: '--ink-faint',
        width: 1.5,
        dash: [2, 3],
        step: false,
        values: alignTo(x, previous, first).map(pct),
        format: fmt,
      })
    }
    return series
  }, [x, rows, previous, past, pastEndS, data.columns])

  const prices = useMemo(() => {
    const slots = mergePrices(history?.prices ?? [], data.prices)
    if (slots.length === 0) return null
    const px = slots.map((p) => Date.parse(p.start) / 1000)
    const imp: (number | null)[] = slots.map((p) => p.import_price)
    const exp: (number | null)[] = slots.map((p) => p.export_price)
    const last = px[px.length - 1]
    if (last !== undefined) {
      px.push(last + 900)
      imp.push(imp[imp.length - 1] ?? null)
      exp.push(exp[exp.length - 1] ?? null)
    }
    const fmt = (v: number) => formatPrice(v)
    const series: ChartSeries[] = [
      { label: 'Import', color: '--series-1', values: imp, format: fmt },
      { label: 'Export', color: '--series-2', values: exp, format: fmt },
    ]
    return { x: px, series, bands: forecastBands(slots), shade: pastShade(px, pastEndS) }
  }, [history, data.prices, pastEndS])

  const hasPast = past.length > 0
  return (
    <div className="chart-stack">
      <p className="chart-note chart-zoom" role="status">
        {zoom ? (
          <>
            Showing {windowLabel(zoom, data.timezone)}
            <button type="button" className="quiet" onClick={() => setZoom(null)}>
              Reset zoom
            </button>
          </>
        ) : (
          `Drag across a chart to zoom in; double-click to see the whole ${hasPast ? 'range' : 'plan'} again.`
        )}
      </p>
      <section className="chart-block">
        <h3>Power</h3>
        <TimeChart
          x={x}
          series={power}
          ariaLabel="Power per quarter-hour: measured history and the plan for battery, grid, PV, house load and deferrable loads"
          syncKey={SYNC}
          yFormat={kwTick}
          fit={POWER_FIT}
          xRange={zoom}
          onZoom={zoomTo}
          shade={shade}
          now={nowS}
          timeZone={data.timezone}
          height={240}
        />
        {hasPast && (
          <p className="chart-note">
            Left of the now line: measured values (solid) and what the plan said at the time (dashed). Right of it: the
            current plan.
          </p>
        )}
      </section>
      {soc && (
        <section className="chart-block">
          <h3>Battery state of charge</h3>
          <TimeChart
            x={x}
            series={soc}
            ariaLabel="Battery state of charge: measured history, what the plan said at the time, the current plan and the previous plan"
            syncKey={SYNC}
            yFormat={(v) => `${v.toFixed(0)} %`}
            fit={SOC_FIT}
            xRange={zoom}
            onZoom={zoomTo}
            shade={shade}
            now={nowS}
            timeZone={data.timezone}
            height={170}
          />
        </section>
      )}
      {prices && (
        <section className="chart-block">
          <h3>Prices</h3>
          <TimeChart
            x={prices.x}
            series={prices.series}
            ariaLabel="Import and export price per quarter-hour; shaded where the price is a forecast"
            syncKey={SYNC}
            yFormat={eurTick}
            fit={PRICE_FIT}
            legendValueWidth="13ch"
            xRange={zoom}
            onZoom={zoomTo}
            bands={prices.bands}
            shade={prices.shade}
            now={nowS}
            timeZone={data.timezone}
            height={170}
          />
          {prices.bands.length > 0 && <p className="chart-note">Shaded: forecast prices, not yet published by Nord Pool.</p>}
        </section>
      )}
    </div>
  )
}
