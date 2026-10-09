import { useMemo, useState } from 'react'
import type { PlanPrice, PlanResponse, PlanRow } from '../../api/types'
import { TimeChart, type ChartSeries } from '../../components/charts/TimeChart'
import { snapWindow } from '../../lib/chartRange'
import { alignTo, deferrableColumns, hasColumn, stepSeries } from '../../lib/plan'
import { formatPower } from '../../lib/units'

const SYNC = 'plan'

// Each y-axis hugs its own data; the minimum spans keep near-flat lines from turning into noise.
const POWER_FIT = { minSpan: 500 }
const SOC_FIT = { minSpan: 5, clamp: [0, 100] as [number, number] }
const PRICE_FIT = { minSpan: 1 }

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

/** Power, state of charge and prices on one synced time axis. */
export function PlanCharts({ data, nowS }: { data: PlanResponse; nowS: number }) {
  // One zoom window for all three charts (unix seconds); null shows the whole plan
  const [zoom, setZoom] = useState<[number, number] | null>(null)
  const zoomTo = (range: [number, number] | null) => setZoom(range && snapWindow(range, 900))
  const currentRows = data.current?.rows
  const previousRows = data.previous?.rows
  const rows = useMemo(() => (currentRows ?? []) as PlanRow[], [currentRows])
  const previous = useMemo(() => (previousRows ?? []) as PlanRow[], [previousRows])

  const power = useMemo(() => {
    const deferrables = deferrableColumns(data.columns)
    // Fixed slot order: battery, grid, PV, load, deferrable loads.
    const spec = [
      { column: 'P_batt', label: 'Battery (+ discharge)', color: '--series-1' },
      { column: 'P_grid', label: 'Grid (+ import)', color: '--series-2' },
      { column: 'P_PV', label: 'PV', color: '--series-3' },
      { column: 'P_Load', label: 'House load', color: '--series-4' },
    ].filter((s) => hasColumn(rows, s.column))
    const { x, ys } = stepSeries(
      rows,
      spec.map((s) => s.column),
    )
    const series: ChartSeries[] = spec.map((s, i) => ({
      label: s.label,
      color: s.color,
      values: ys[i] ?? [],
      format: formatPower,
    }))
    if (deferrables.length > 0) {
      const parts = stepSeries(rows, deferrables).ys
      const total = x.map((_, i) => {
        let sum: number | null = null
        for (const p of parts) {
          const v = p[i]
          if (v !== null && v !== undefined) sum = (sum ?? 0) + v
        }
        return sum
      })
      series.push({
        label: deferrables.length === 1 ? 'Deferrable load' : 'Deferrable loads',
        color: '--series-5',
        values: total,
        format: formatPower,
      })
    }
    return { x, series }
  }, [rows, data.columns])

  const soc = useMemo(() => {
    if (!hasColumn(rows, 'SOC_opt')) return null
    const { x, ys } = stepSeries(rows, ['SOC_opt'])
    const pct = (v: number | null) => (v === null ? null : v * 100)
    const fmt = (v: number) => `${v.toFixed(1)} %`
    const series: ChartSeries[] = [
      { label: 'Planned SOC', color: '--series-1', values: (ys[0] ?? []).map(pct), step: false, format: fmt },
    ]
    if (previous.length > 0) {
      series.push({
        label: 'Previous plan',
        color: '--ink-faint',
        width: 1.5,
        dash: [4, 4],
        step: false,
        values: alignTo(x, previous, 'SOC_opt').map(pct),
        format: fmt,
      })
    }
    return { x, series }
  }, [rows, previous])

  const prices = useMemo(() => {
    const slots = data.prices
    if (slots.length === 0) return null
    const x = slots.map((p) => Date.parse(p.start) / 1000)
    const imp: (number | null)[] = slots.map((p) => p.import_price * 100)
    const exp: (number | null)[] = slots.map((p) => p.export_price * 100)
    const last = x[x.length - 1]
    if (last !== undefined) {
      x.push(last + 900)
      imp.push(imp[imp.length - 1] ?? null)
      exp.push(exp[exp.length - 1] ?? null)
    }
    const fmt = (v: number) => `${v.toFixed(2)} c/kWh`
    const series: ChartSeries[] = [
      { label: 'Import', color: '--series-1', values: imp, format: fmt },
      { label: 'Export', color: '--series-2', values: exp, format: fmt },
    ]
    return { x, series, bands: forecastBands(slots) }
  }, [data.prices])

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
          'Drag across a chart to zoom in; double-click to see the whole plan again.'
        )}
      </p>
      <section className="chart-block">
        <h3>Power</h3>
        <TimeChart
          x={power.x}
          series={power.series}
          ariaLabel="Planned power per quarter-hour: battery, grid, PV, house load and deferrable loads"
          syncKey={SYNC}
          yFormat={kwTick}
          fit={POWER_FIT}
          xRange={zoom}
          onZoom={zoomTo}
          now={nowS}
          timeZone={data.timezone}
          height={240}
        />
      </section>
      {soc && (
        <section className="chart-block">
          <h3>Battery state of charge</h3>
          <TimeChart
            x={soc.x}
            series={soc.series}
            ariaLabel="Planned battery state of charge, with the previous plan for comparison"
            syncKey={SYNC}
            yFormat={(v) => `${v.toFixed(0)} %`}
            fit={SOC_FIT}
            xRange={zoom}
            onZoom={zoomTo}
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
            yFormat={(v) => `${v.toFixed(0)} c`}
            fit={PRICE_FIT}
            xRange={zoom}
            onZoom={zoomTo}
            bands={prices.bands}
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
