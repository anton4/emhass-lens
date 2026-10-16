// The Plan page's chart series: what was measured left of now and what the plan says right of it, per quarter-hour,
// as the Power, state-of-charge and price charts draw them. Pure, so the desktop charts and the phone's share them.

import type { GridDetail, HistorySlot, PlanPrice, PlanRow } from '../api/types'
import type { ChartLane, ChartSeries } from '../components/charts/TimeChart'
import type { PopupTag } from '../components/charts/cursorStore'
import { gridAt, gridRangeAt, withoutCovered } from './gridDetail'
import { alignTo, deferrableColumns, hasColumn, socColumns } from './plan'
import {
  deferrableFuture,
  hasMeasured,
  hasPlanned,
  mergePrices,
  pastAndFuture,
  plannedAtTheTime,
} from './planHistory'
import { IDLE_W } from './planSummary'
import { powerStack, type FlowKey } from './powerStack'
import { isForecast, originLabel, priceHeatLane } from './prices'
import { formatPower, formatSignedPower } from './units'

export const charging = (w: number) => (w >= IDLE_W ? 'charging' : w <= -IDLE_W ? 'discharging' : 'idle')
export const importing = (w: number) => (w >= IDLE_W ? 'importing' : w <= -IDLE_W ? 'exporting' : 'no flow')

/** What the plan said at the time: thin, grey and dashed under the measured line. */
export const THEN = { color: '--chart-then', width: 1.25, dash: [3, 3] as number[] }

// right of now the plan is drawn fainter than what was measured: its areas, its lines, its grid
export const PLAN_AREA = { fill: 0.2 / 0.45 }
export const PLAN_LINE = { line: 0.6 }
export const PLAN_SOC = { line: 0.5 }

/** Measured left of now and planned right of it, per quarter-hour, for the Power chart (W; the battery in EMHASS's
 *  sign, + discharge). */
export interface Flows {
  pv: (number | null)[] | null
  battery: (number | null)[] | null
  load: (number | null)[] | null
  grid: (number | null)[] | null
  /** What the plan said at the time for the grid, left of now. */
  gridThen: (number | null)[] | null
  deferrable: (number | null)[] | null
  deferrableLabel: string
}

/** The flows on grid `x`: each one the plan has a column for or the history measured. */
export function planFlows(
  x: number[],
  past: HistorySlot[],
  rows: PlanRow[],
  pastEndS: number,
  columns: string[],
): Flows {
  const has = (key: 'pv' | 'batt' | 'load' | 'grid', column: string) => hasColumn(rows, column) || hasMeasured(past, key)
  const values = (key: 'pv' | 'batt' | 'load' | 'grid', column: string) =>
    has(key, column) ? pastAndFuture(x, past, key, rows, column, pastEndS) : null
  const deferrables = deferrableColumns(columns)
  return {
    pv: values('pv', 'P_PV'),
    battery: values('batt', 'P_batt'),
    load: values('load', 'P_Load'),
    grid: values('grid', 'P_grid'),
    gridThen: hasPlanned(past, 'P_grid') ? plannedAtTheTime(x, past, 'P_grid') : null,
    deferrable: deferrables.length > 0 ? deferrableFuture(x, rows, deferrables, pastEndS) : null,
    deferrableLabel: deferrables.length === 1 ? 'Deferrable load' : 'Deferrable loads',
  }
}

/** The state of charge in %: measured, then the plan (fainter); what the plan said at the time; any further batteries;
 *  the previous plan. Null when there is nothing to draw. */
export function socSeries(
  x: number[],
  past: HistorySlot[],
  rows: PlanRow[],
  previous: PlanRow[],
  pastEndS: number,
  columns: string[],
): ChartSeries[] | null {
  const socs = socColumns(columns).filter((c) => hasColumn(rows, c))
  const plannedSoc = hasPlanned(past, 'SOC')
  if (socs.length === 0 && !plannedSoc && !hasMeasured(past, 'soc')) return null
  const fmt = (v: number) => `${v.toFixed(1)} %`
  const series: ChartSeries[] = []
  const firstSoc = socs[0] ?? 'SOC_opt'
  series.push({
    label: socs.length > 1 ? 'Battery 1 SOC' : 'Battery SOC',
    popupLabel: socs.length > 1 ? 'Battery 1' : 'State of charge',
    color: '--q-soc',
    step: false,
    values: pastAndFuture(x, past, 'soc', rows, firstSoc, pastEndS, 100, false),
    format: fmt,
    fade: PLAN_SOC,
  })
  if (plannedSoc) {
    series.push({
      label: socs.length > 1 ? 'Battery 1, planned at the time' : 'Planned at the time',
      ...THEN,
      step: false,
      values: plannedAtTheTime(x, past, 'SOC', 100, false),
      format: fmt,
      then: true,
    })
  }
  socs.slice(1).forEach((column, i) => {
    series.push({
      label: `Battery ${i + 2} SOC`,
      color: `--series-${i + 2}`,
      step: false,
      values: pastAndFuture(x, past, null, rows, column, pastEndS, 100, false),
      format: fmt,
      fade: PLAN_SOC,
    })
  })
  if (previous.length > 0) {
    const pct = (v: number | null) => (v === null ? null : v * 100)
    series.push({
      label: socs.length > 1 ? 'Battery 1, previous plan' : 'Previous plan',
      color: '--ink-faint',
      width: 1.5,
      dash: [2, 3],
      step: false,
      values: alignTo(x, previous, firstSoc).map(pct),
      format: fmt,
    })
  }
  return series
}

/** Contiguous forecast ranges of plan prices (unix seconds). */
export function forecastBands(prices: PlanPrice[]): [number, number][] {
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

export interface PriceSeries {
  /** Slot starts, plus a closing point. */
  x: number[]
  series: ChartSeries[]
  /** Where the price is a forecast. */
  bands: [number, number][]
  /** Where each slot's price came from, for the popup. */
  tag: (t: number) => PopupTag | null
  /** The import price as a ribbon under the chart. */
  heat: ChartLane
  /** The import price per slot start, for the extremes and the ribbon's range. */
  imports: { t: number; value: number }[]
}

/** Import and export price per quarter-hour, past (history) and ahead (the plan); null without prices. */
export function priceSeries(past: PlanPrice[], ahead: PlanPrice[]): PriceSeries | null {
  const slots = mergePrices(past, ahead)
  if (slots.length === 0) return null
  const px = slots.map((p) => Date.parse(p.start) / 1000)
  const imp: (number | null)[] = slots.map((p) => p.import_price)
  const exp: (number | null)[] = slots.map((p) => p.export_price)
  const heat = priceHeatLane(px, imp)
  const imports = slots.flatMap((p, i) => (p.import_price === null ? [] : [{ t: px[i]!, value: p.import_price }]))
  const lastPx = px[px.length - 1]
  if (lastPx !== undefined) {
    px.push(lastPx + 900)
    imp.push(imp[imp.length - 1] ?? null)
    exp.push(exp[exp.length - 1] ?? null)
  }
  const fmt = (v: number) => `${v.toFixed(3)} €/kWh`
  const series: ChartSeries[] = [
    { label: 'Import', color: '--q-import', values: imp, format: fmt },
    { label: 'Export', color: '--q-export', values: exp, format: fmt },
  ]
  const origins = new Map(slots.map((p) => [Date.parse(p.start) / 1000, p.origin]))
  const tag = (t: number): PopupTag | null => {
    const origin = origins.get(t)
    return origin ? { text: originLabel(origin), tone: isForecast(origin) ? 'blue' : 'neutral' } : null
  }
  return { x: px, series, bands: forecastBands(slots), tag, heat, imports }
}

/** What the Power chart's parts are called and coloured. */
export const POWER_LAYERS = (deferrableLabel: string): Record<FlowKey, { label: string; color: string }> => ({
  pv: { label: 'PV', color: '--q-pv' },
  discharge: { label: 'Battery', color: '--q-batt' },
  load: { label: 'House load', color: '--q-load' },
  charge: { label: 'Battery charging', color: '--q-batt' },
  deferrable: { label: deferrableLabel, color: '--q-ev' },
})

/** The Power chart's series: PV and the battery discharging stacked above zero, the house load, the battery charging
 *  and the deferrable loads below, then the grid as a line on top: where the grid's readings cover a measured
 *  quarter-hour (`cover`) their line draws it, and the popup reads them at the pointer; then what the plan said at the
 *  time. The parts `hidden` says are left out. */
export function powerSeries(o: {
  x: number[]
  flows: Flows
  hidden: (part: 'grid' | 'pv' | 'batt' | 'load' | 'deferrable') => boolean
  cover: [number, number] | null
  pastEndS: number
  nowS: number
  gridData: GridDetail | undefined
}): ChartSeries[] {
  const { x, flows, hidden, cover, pastEndS, nowS, gridData } = o
  const layers = powerStack({
    pv: hidden('pv') ? null : flows.pv,
    battery: hidden('batt') ? null : flows.battery,
    load: hidden('load') ? null : flows.load,
    deferrable: hidden('deferrable') ? null : flows.deferrable,
  })
  const LAYERS = POWER_LAYERS(flows.deferrableLabel)
  const out: ChartSeries[] = []
  const index = new Map<FlowKey, number>()
  for (const layer of layers) {
    const meta = LAYERS[layer.key]
    const battery = layer.key === 'discharge'
    index.set(layer.key, out.length)
    out.push({
      label: meta.label,
      color: meta.color,
      values: layer.edge,
      width: 0,
      fill: 0.45,
      below: layer.on ? index.get(layer.on) : undefined,
      // the battery's one popup row, on its discharging layer: + charge, like the grid's import
      readout: battery ? (flows.battery?.map((v) => (v === null ? null : -v)) ?? layer.own) : layer.own,
      format: battery ? formatSignedPower : formatPower,
      describe: battery ? charging : undefined,
      helper: layer.key === 'charge',
      fade: PLAN_AREA,
    })
  }
  if (flows.grid && !hidden('grid')) {
    const grid = flows.grid
    out.push({
      label: 'Grid',
      color: '--q-grid',
      width: 2,
      // the measured quarter-hours the readings cover are drawn by their line; the popup reads that line at the
      // pointer, with the quarter-hour's mean and the bucket's lowest and highest reading under it
      values: cover ? withoutCovered(x, grid, cover, pastEndS) : grid,
      readout: grid,
      moment: (time: number) => (time < nowS ? gridAt(gridData, time) : null),
      momentRange: (time: number) => (time < nowS ? gridRangeAt(gridData, time) : null),
      format: formatSignedPower,
      describe: importing,
      lead: true,
      fade: PLAN_LINE,
    })
    if (flows.gridThen) {
      out.push({
        label: 'Grid, planned at the time',
        ...THEN,
        values: flows.gridThen,
        format: formatSignedPower,
        then: true,
      })
    }
  }
  return out
}
