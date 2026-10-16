import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useGridDetail, useJobs, useMarketCommands, useRuns } from '../../api/queries'
import type { PlanHistoryResponse, PlanPrice, PlanResponse, PlanRow, RunSummary } from '../../api/types'
import { Overview } from '../../components/charts/Overview'
import {
  TimeChart,
  type ChartGap,
  type ChartLane,
  type ChartOverlay,
  type ChartSeries,
  type ChartSession,
  type ChartSplit,
  type ChartTick,
} from '../../components/charts/TimeChart'
import { Lamp } from '../../components/Lamp'
import { useNow } from '../../components/useNow'
import { formatClock, formatCountdown, formatSlot } from '../../lib/format'
import { momentLabel } from '../../lib/chartPopup'
import { clampWindow } from '../../lib/chartRange'
import {
  detailCover,
  detailRequest,
  gridAt,
  gridDetailNote,
  gridOverlay,
  gridRangeAt,
  planTail,
  withoutCovered,
} from '../../lib/gridDetail'
import {
  commandSessions,
  marketBlock,
  marketLane,
  marketOverlay,
  sessionBands,
  sessionWindow,
  shortfallGap,
  shortfalls,
} from '../../lib/market'
import { OUTCOMES, outcomeLabel } from '../../lib/outcomes'
import { alignTo, deferrableColumns, hasColumn, socColumns } from '../../lib/plan'
import { IDLE_W } from '../../lib/planSummary'
import { powerStack, type FlowKey } from '../../lib/powerStack'
import { isForecast, originLabel, priceHeatLane } from '../../lib/prices'
import {
  deferrableFuture,
  hasMeasured,
  hasPlanned,
  mergePrices,
  pastAndFuture,
  pastEnd,
  plannedAtTheTime,
  timeGrid,
  viewRange,
  type ViewHours,
} from '../../lib/planHistory'
import { eurTick, formatPower, formatSignedPower } from '../../lib/units'

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
    fmt = new Intl.DateTimeFormat(undefined, {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
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

const charging = (w: number) => (w >= IDLE_W ? 'charging' : w <= -IDLE_W ? 'discharging' : 'idle')
const importing = (w: number) => (w >= IDLE_W ? 'importing' : w <= -IDLE_W ? 'exporting' : 'no flow')

const DASHED = { width: 1.5, dash: [4, 4] as number[] }

// right of now the plan is drawn fainter than what was measured: its areas, its lines, its grid
const PLAN_AREA = { fill: 0.2 / 0.45 }
const PLAN_LINE = { line: 0.6 }
const PLAN_SOC = { line: 0.5 }

/** Measured left of now and planned right of it, per quarter-hour, for the Power chart (W; the battery in EMHASS's
 *  sign, + discharge). */
interface Flows {
  pv: (number | null)[] | null
  battery: (number | null)[] | null
  load: (number | null)[] | null
  grid: (number | null)[] | null
  /** What the plan said at the time for the grid, left of now. */
  gridThen: (number | null)[] | null
  deferrable: (number | null)[] | null
  deferrableLabel: string
}

/** What the Power chart's chips switch: the grid line, each stacked flow, and Qilowatt's commands: the commanded power
 *  with its shortfalls ('market-power'), and the sessions as bands, flags and a lane ('market-commands'). */
type PowerPart = 'grid' | 'pv' | 'batt' | 'load' | 'deferrable' | 'market-power' | 'market-commands'

// The parts hidden are remembered in this browser only; blocked storage just means all shown.
const HIDDEN_KEY = 'emhass-lens.plan.power.hidden'

function loadHidden(): Set<PowerPart> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? 'null')
    if (Array.isArray(saved)) return new Set(saved.filter((p): p is PowerPart => typeof p === 'string') as PowerPart[])
  } catch {
    // fall through to the default
  }
  return new Set()
}

function saveHidden(hidden: Set<PowerPart>) {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]))
  } catch {
    // not remembered, still works for this visit
  }
}

interface PowerChip {
  part: PowerPart
  label: string
  color: string
  /** Drawn as an area (a square swatch) rather than a line. */
  area?: boolean
}

/** Power, state of charge and prices on one synced time axis, with the MPC runs and an overview of everything
 *  loaded under them. They show a window around now (`view`) that follows the clock, until a zoom, a scroll or the
 *  overview's brush picks a window of its own; double-click or "Back to now" returns to following. */
export function PlanCharts({
  data,
  history,
  nowS,
  view,
}: {
  data: PlanResponse
  history?: PlanHistoryResponse
  nowS: number
  view: ViewHours
}) {
  // a window picked by zooming, scrolling or the overview (unix seconds); null follows now
  const [zoom, setZoom] = useState<[number, number] | null>(null)
  const currentRows = data.current?.rows
  const previousRows = data.previous?.rows
  const rows = useMemo(() => (currentRows ?? []) as PlanRow[], [currentRows])
  const previous = useMemo(() => (previousRows ?? []) as PlanRow[], [previousRows])
  const past = useMemo(() => history?.slots ?? [], [history])
  const pastEndS = pastEnd(past, nowS)
  const x = useMemo(() => timeGrid(past, rows), [past, rows])
  // the plan right of the now line: fainter, on a light wash
  const ahead = useMemo<ChartSplit>(() => ({ at: nowS, side: 'after', wash: '--chart-ahead' }), [nowS])
  const first = x[0]
  const last = x[x.length - 1]
  const bounds = useMemo<[number, number] | null>(
    () => (first !== undefined && last !== undefined && last > first ? [first, last] : null),
    [first, last],
  )
  const shown = zoom ?? (bounds ? viewRange(view, nowS, bounds) : null)
  const zoomTo = (range: [number, number] | null) => setZoom(range && bounds ? clampWindow(range, bounds) : null)

  const flows = useMemo<Flows>(() => {
    const has = (key: 'pv' | 'batt' | 'load' | 'grid', column: string) => hasColumn(rows, column) || hasMeasured(past, key)
    const values = (key: 'pv' | 'batt' | 'load' | 'grid', column: string) =>
      has(key, column) ? pastAndFuture(x, past, key, rows, column, pastEndS) : null
    const deferrables = deferrableColumns(data.columns)
    return {
      pv: values('pv', 'P_PV'),
      battery: values('batt', 'P_batt'),
      load: values('load', 'P_Load'),
      grid: values('grid', 'P_grid'),
      gridThen: hasPlanned(past, 'P_grid') ? plannedAtTheTime(x, past, 'P_grid') : null,
      deferrable: deferrables.length > 0 ? deferrableFuture(x, rows, deferrables, pastEndS) : null,
      deferrableLabel: deferrables.length === 1 ? 'Deferrable load' : 'Deferrable loads',
    }
  }, [x, rows, past, pastEndS, data.columns])

  const soc = useMemo(() => {
    const columns = socColumns(data.columns).filter((c) => hasColumn(rows, c))
    const plannedSoc = hasPlanned(past, 'SOC')
    if (columns.length === 0 && !plannedSoc && !hasMeasured(past, 'soc')) return null
    const fmt = (v: number) => `${v.toFixed(1)} %`
    const series: ChartSeries[] = []
    const firstSoc = columns[0] ?? 'SOC_opt'
    series.push({
      label: columns.length > 1 ? 'Battery 1 SOC' : 'Battery SOC',
      popupLabel: columns.length > 1 ? 'Battery 1' : 'State of charge',
      color: '--q-soc',
      step: false,
      values: pastAndFuture(x, past, 'soc', rows, firstSoc, pastEndS, 100, false),
      format: fmt,
      fade: PLAN_SOC,
    })
    if (plannedSoc) {
      series.push({
        label: columns.length > 1 ? 'Battery 1, planned at the time' : 'Planned at the time',
        color: '--q-soc',
        ...DASHED,
        step: false,
        values: plannedAtTheTime(x, past, 'SOC', 100, false),
        format: fmt,
        then: true,
      })
    }
    columns.slice(1).forEach((column, i) => {
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
        label: columns.length > 1 ? 'Battery 1, previous plan' : 'Previous plan',
        color: '--ink-faint',
        width: 1.5,
        dash: [2, 3],
        step: false,
        values: alignTo(x, previous, firstSoc).map(pct),
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
    const heat: ChartLane = priceHeatLane(px, imp)
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
    const tag = (t: number) => {
      const origin = origins.get(t)
      return origin ? { text: originLabel(origin), tone: isForecast(origin) ? ('blue' as const) : ('neutral' as const) } : null
    }
    return { x: px, series, bands: forecastBands(slots), tag, heat }
  }, [history, data.prices])

  // the overview's sessions: the same commands the Power chart reads (one query)
  const since = first !== undefined ? new Date(Math.floor(first / 3600) * 3600 * 1000).toISOString() : null
  const commands = useMarketCommands(since)
  const overviewSessions = useMemo(
    () =>
      sessionBands(commandSessions(commands.data?.spans ?? [], nowS), data.timezone).map((b) => ({
        from: b.from,
        to: b.to,
        color: b.color,
      })),
    [commands.data, nowS, data.timezone],
  )

  const hasPast = past.length > 0
  // the popup's tag: measured left of the now line, the plan right of it
  const slotTag = {
    tag: (t: number) =>
      t < pastEndS ? { text: 'measured', tone: 'neutral' as const } : { text: 'plan', tone: 'blue' as const },
  }
  return (
    <div className="chart-stack">
      <div className="chart-window" role="status">
        {shown && (
          <span>
            Showing <b>{windowLabel(shown, data.timezone)}</b>
          </span>
        )}
        {zoom ? (
          <button type="button" className="quiet" onClick={() => setZoom(null)}>
            Back to now
          </button>
        ) : (
          <span className="chart-live">
            <span className="chart-live-dot" aria-hidden="true" />
            following now
          </span>
        )}
        <span className="chart-hint">
          Point at a chart for its values · scroll to zoom · drag to zoom in · Shift+scroll to move · double-click: back
          to now
        </span>
      </div>
      <PowerChart
        x={x}
        flows={flows}
        hasPast={hasPast}
        zoom={shown}
        following={zoom === null}
        onZoom={zoomTo}
        split={ahead}
        nowS={nowS}
        pastEndS={pastEndS}
        timeZone={data.timezone}
        slotTag={slotTag}
      />
      {soc && (
        <section className="chart-block">
          <h3>
            Battery state of charge <span className="chart-unit">%</span>
          </h3>
          <TimeChart
            x={x}
            series={soc}
            ariaLabel="Battery state of charge: measured history, what the plan said at the time, the current plan and the previous plan"
            syncKey={SYNC}
            yFormat={(v) => `${v.toFixed(0)} %`}
            fit={SOC_FIT}
            xRange={shown}
            onZoom={zoomTo}
            split={ahead}
            now={nowS}
            timeZone={data.timezone}
            height={190}
            popup={slotTag}
          />
        </section>
      )}
      {prices && (
        <section className="chart-block">
          <h3>
            Price <span className="chart-unit">€/kWh, fees and VAT included</span>
          </h3>
          <TimeChart
            x={prices.x}
            series={prices.series}
            ariaLabel="Import and export price per quarter-hour, with a ribbon of the import price from cheap (light) to dear (deep); shaded where the price is a forecast"
            syncKey={SYNC}
            yFormat={eurTick}
            fit={PRICE_FIT}
            xRange={shown}
            onZoom={zoomTo}
            bands={prices.bands}
            now={nowS}
            timeZone={data.timezone}
            height={200}
            popup={{ tag: prices.tag }}
            lanes={[prices.heat]}
          />
          {prices.bands.length > 0 && (
            <p className="chart-note">Shaded: forecast prices, not yet published by Nord Pool.</p>
          )}
        </section>
      )}
      <MpcRunStrip x={x} zoom={shown} onZoom={zoomTo} nowS={nowS} timeZone={data.timezone} />
      {bounds && shown && (
        <section className="chart-block">
          <h3>
            Overview <span className="chart-unit">everything loaded · drag the box to move the window</span>
          </h3>
          <Overview
            bounds={bounds}
            window={shown}
            onWindow={zoomTo}
            line={{ x, values: flows.grid ?? [] }}
            sessions={overviewSessions}
            nowS={nowS}
            timeZone={data.timezone}
          />
        </section>
      )}
    </div>
  )
}

/** The MPC runs on the same time axis as the charts, coloured by outcome; a click opens the run. */
function MpcRunStrip({
  x,
  zoom,
  onZoom,
  nowS,
  timeZone,
}: {
  x: number[]
  zoom: [number, number] | null
  onZoom: (range: [number, number] | null) => void
  nowS: number
  timeZone: string
}) {
  const navigate = useNavigate()
  // Whole hours keep the query key steady while the chart's first slot moves on
  const first = x[0]
  const since = first !== undefined ? new Date(Math.floor(first / 3600) * 3600 * 1000).toISOString() : undefined
  const runs = useRuns({ job: 'emhass.mpc', since, limit: 1000 })
  const list = useMemo(() => runs.data ?? [], [runs.data])
  const ticks = useMemo<ChartTick[]>(
    () =>
      list.map((r) => ({
        t: Date.parse(r.started_at) / 1000,
        color: `--lamp-${OUTCOMES[r.outcome]?.color ?? 'neutral'}`,
        label: `Run ${r.id} · ${formatClock(r.started_at, timeZone)} · ${outcomeLabel(r.outcome)}${r.summary ? `\n${r.summary}` : ''}`,
        id: r.id,
      })),
    [list, timeZone],
  )
  const empty = useMemo(() => [{ label: 'MPC runs', color: 'transparent', values: x.map(() => null) }], [x])
  if (x.length === 0) return null
  return (
    <section className="chart-block run-strip">
      <h3>MPC runs</h3>
      <TimeChart
        x={x}
        series={empty}
        ariaLabel="The MPC runs in this window on the same time axis, coloured by outcome"
        syncKey={SYNC}
        compact
        yRange={[0, 1]}
        xRange={zoom}
        onZoom={onZoom}
        now={nowS}
        timeZone={timeZone}
        height={78}
        ticks={ticks}
        onTick={(tick) => tick.id && navigate(`/runs/${tick.id}`)}
      />
      <RunCounts runs={list} timeZone={timeZone} />
    </section>
  )
}

/** The Power chart: where the house's power comes from (PV, the battery discharging: stacked above zero) and where it
 *  goes (the house load, the battery charging, the deferrable loads: stacked below), per quarter-hour, with the grid
 *  on top as a line: every reading of the grid sensor left of now where there is one (each bucket's lowest and highest
 *  reading on a long window), the plan's quarter-hours right of it, and what the plan said at the time. Qilowatt's
 *  commands from the Home Assistant recorder too: each session a band with a flag and a bar in the lane under the
 *  chart (a click zooms to it), the commanded power as an ink line, and where the grid fell short of it, hatched.
 *  Chips under it switch each part. */
function PowerChart({
  x,
  flows,
  hasPast,
  zoom,
  following,
  onZoom,
  split,
  nowS,
  pastEndS,
  timeZone,
  slotTag,
}: {
  x: number[]
  flows: Flows
  hasPast: boolean
  zoom: [number, number] | null
  following: boolean
  onZoom: (range: [number, number] | null) => void
  split: ChartSplit
  nowS: number
  pastEndS: number
  timeZone: string
  slotTag: { tag: (t: number) => { text: string; tone: 'neutral' | 'blue' } }
}) {
  const [hidden, setHidden] = useState(loadHidden)
  const toggle = (part: PowerPart) => {
    const next = new Set(hidden)
    if (next.has(part)) next.delete(part)
    else next.add(part)
    setHidden(next)
    saveHidden(next)
  }
  // Whole hours keep the query key steady while the chart's first slot moves on
  const first = x[0]
  const since = first !== undefined ? new Date(Math.floor(first / 3600) * 3600 * 1000).toISOString() : null
  const commands = useMarketCommands(since)
  const spans = useMemo(() => commands.data?.spans ?? [], [commands.data])
  const showPower = spans.length > 0 && !hidden.has('market-power')
  const showSessions = spans.length > 0 && !hidden.has('market-commands')
  // the measured part of the window shown, every reading the grid sensor gave: the grid's line there
  const showGrid = flows.grid !== null && !hidden.has('grid')
  const detail = useGridDetail(zoom ? detailRequest(zoom, nowS, !following) : null, showGrid)
  const gridData = showGrid ? detail.data : undefined
  const cover = useMemo(() => detailCover(gridData), [gridData])

  const series = useMemo(() => {
    const layers = powerStack({
      pv: hidden.has('pv') ? null : flows.pv,
      battery: hidden.has('batt') ? null : flows.battery,
      load: hidden.has('load') ? null : flows.load,
      deferrable: hidden.has('deferrable') ? null : flows.deferrable,
    })
    const LAYERS: Record<FlowKey, { label: string; color: string }> = {
      pv: { label: 'PV', color: '--q-pv' },
      discharge: { label: 'Battery', color: '--q-batt' },
      load: { label: 'House load', color: '--q-load' },
      charge: { label: 'Battery charging', color: '--q-batt' },
      deferrable: { label: flows.deferrableLabel, color: '--q-ev' },
    }
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
    if (flows.grid && !hidden.has('grid')) {
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
          color: '--q-grid',
          ...DASHED,
          values: flows.gridThen,
          format: formatSignedPower,
          then: true,
        })
      }
    }
    return out
  }, [flows, hidden, cover, x, pastEndS, nowS, gridData])

  // the plan's grid in the slot in progress, from where the measured line ends: one grid line there too
  const tail = useMemo(
    () => (flows.grid && !hidden.has('grid') ? planTail(x, flows.grid, cover, pastEndS) : null),
    [flows.grid, hidden, x, cover, pastEndS],
  )
  const sessions = useMemo(() => commandSessions(spans, nowS), [spans, nowS])
  const runs = useMemo(() => (showPower ? shortfalls(spans, gridData, nowS) : []), [showPower, spans, gridData, nowS])
  // the measured grid's line on top of the bold commanded one, so both show where they agree
  const overlays = useMemo<ChartOverlay[]>(
    () => [
      ...(tail
        ? [{ label: 'Grid', color: '--q-grid', width: 2, base: 'none' as const, spans: tail, fade: PLAN_LINE.line }]
        : []),
      ...(showPower ? [marketOverlay(spans, nowS)] : []),
      ...(gridData && gridData.points.length > 0 ? [gridOverlay(gridData)] : []),
    ],
    [tail, gridData, showPower, spans, nowS],
  )
  const gaps = useMemo<ChartGap[]>(() => (runs.length > 0 ? [shortfallGap(runs)] : []), [runs])
  const bands = useMemo<ChartSession[]>(
    () => (showSessions ? sessionBands(sessions, timeZone) : []),
    [showSessions, sessions, timeZone],
  )
  const lanes = useMemo<ChartLane[]>(
    () => (showSessions ? [marketLane(sessions, runs)] : []),
    [showSessions, sessions, runs],
  )
  const popup = useMemo(() => {
    const market = showPower || showSessions
    const block = (time: number) =>
      market ? marketBlock({ spans, sessions, runs, detail: gridData, time, nowS, timeZone }) : null
    return {
      ...slotTag,
      // left of now the popup is about the pointer's own moment (the grid's reading, a command); the slot heads the rows
      head: gridData || market ? (_t: number, time: number) => (time < nowS ? momentLabel(time, timeZone) : null) : undefined,
      block: market ? (_t: number, time: number) => block(time) : undefined,
    }
  }, [slotTag, gridData, showPower, showSessions, spans, sessions, runs, nowS, timeZone])
  // a flag can stand for several sessions of one direction: zoom to all of them
  const zoomToSession = (ids: string[]) => {
    const chosen = sessions.filter((s) => ids.includes(s.id))
    if (chosen.length === 0) return
    onZoom(sessionWindow({ from: Math.min(...chosen.map((s) => s.from)), to: Math.max(...chosen.map((s) => s.to)) }))
  }
  const detailNote = gridDetailNote(gridData?.step_s)
  const gridTitle = gridData?.error
    ? gridData.error
    : gridData?.step_s
      ? `Left of now every reading: means ${detailNote?.replace('measured ', '')}, drawn through each one's lowest and highest reading; the plan right of now`
      : detailNote
        ? `Left of now ${detailNote}, the plan right of it`
        : undefined
  const chips: PowerChip[] = [
    ...(flows.grid ? [{ part: 'grid' as const, label: 'Grid', color: '--q-grid' }] : []),
    ...(flows.pv ? [{ part: 'pv' as const, label: 'PV', color: '--q-pv', area: true }] : []),
    ...(flows.battery ? [{ part: 'batt' as const, label: 'Battery', color: '--q-batt', area: true }] : []),
    ...(flows.load ? [{ part: 'load' as const, label: 'House load', color: '--q-load', area: true }] : []),
    ...(flows.deferrable
      ? [{ part: 'deferrable' as const, label: flows.deferrableLabel, color: '--q-ev', area: true }]
      : []),
  ]
  const marketChips: PowerChip[] =
    spans.length > 0
      ? [
          { part: 'market-power', label: 'Commanded', color: '--q-market' },
          { part: 'market-commands', label: 'Sessions', color: '--q-sell' },
        ]
      : []
  const chip = (c: PowerChip, title?: string) => (
    <li key={c.part}>
      <button
        type="button"
        className="legend-toggle"
        aria-pressed={!hidden.has(c.part)}
        title={title ?? (hidden.has(c.part) ? 'Show in the chart' : 'Hide from the chart')}
        onClick={() => toggle(c.part)}
      >
        <span
          className="legend-swatch"
          data-area={c.area || undefined}
          data-line={c.part === 'grid' || undefined}
          data-bold={c.part === 'market-power' || undefined}
          data-split={c.part === 'market-commands' || undefined}
          style={{ background: `var(${c.color})`, color: `var(${c.color})` }}
        />
        {c.label}
      </button>
    </li>
  )
  return (
    <section className="chart-block">
      <h3>
        Power <span className="chart-unit">kW · above zero: into the house · below: out of it · the grid line covers the rest</span>
      </h3>
      <TimeChart
        x={x}
        series={series}
        ariaLabel="Power: PV and the battery discharging stacked above zero, the house load, the battery charging and the deferrable loads below, per quarter-hour; the grid as a line on top, every reading left of now and the plan right of it; the market's sessions and commanded power"
        syncKey={SYNC}
        yFormat={kwTick}
        fit={POWER_FIT}
        xRange={zoom}
        onZoom={onZoom}
        split={split}
        now={nowS}
        timeZone={timeZone}
        height={bands.length > 0 ? 356 : 330}
        popup={popup}
        legend={false}
        overlays={overlays}
        gaps={gaps}
        lanes={lanes}
        sessions={bands}
        onSession={zoomToSession}
      />
      <ul className="legend" role="group" aria-label="Parts shown in the Power chart">
        {chips.map((c) => chip(c, c.part === 'grid' ? gridTitle : undefined))}
        {marketChips.length > 0 && (
          <li className="legend-group" aria-hidden="true">
            Market
          </li>
        )}
        {marketChips.map((c) => chip(c))}
        {runs.length > 0 && (
          <li
            className="legend-key"
            title="Where the grid delivered less than commanded by more than 500 W or 10 % for a minute or more"
          >
            <span className="legend-hatch" aria-hidden="true" />
            Shortfall
          </li>
        )}
        {hasPast && flows.gridThen && (
          <li className="legend-key" title="Left of the now line: what the plan said at the time for the grid">
            <span className="legend-dash" aria-hidden="true" />
            grid planned at the time
          </li>
        )}
      </ul>
    </section>
  )
}

/** "38 OK · 2 Shadow build · 1 Error (run 985, 17:13) · Next MPC 17:28 · in 12:41". */
function RunCounts({ runs, timeZone }: { runs: RunSummary[]; timeZone: string }) {
  const jobs = useJobs()
  const now = useNow(1000)
  const mpc = jobs.data?.find((j) => j.id === 'emhass.mpc')
  const groups = new Map<string, RunSummary[]>()
  for (const r of runs) groups.set(r.outcome, [...(groups.get(r.outcome) ?? []), r])
  const order = Object.keys(OUTCOMES)
  const outcomes = [...groups.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return (
    <p className="run-counts">
      {outcomes.map((outcome) => {
        const these = groups.get(outcome) ?? []
        const color = OUTCOMES[outcome]?.color ?? 'neutral'
        const notable = color === 'red' || color === 'amber'
        return (
          <span key={outcome} className="labelled-lamp">
            <Lamp color={color} />
            {these.length} {outcomeLabel(outcome)}
            {notable && these.length <= 3 && (
              <span className="muted">
                {' ('}
                {these.map((r, i) => (
                  <span key={r.id}>
                    {i > 0 && ', '}
                    <Link to={`/runs/${r.id}`}>run {r.id}</Link> {formatClock(r.started_at, timeZone).slice(0, 5)}
                  </span>
                ))}
                {')'}
              </span>
            )}
          </span>
        )
      })}
      {runs.length === 0 && <span className="muted">No MPC runs in this window.</span>}
      {mpc?.next_run && !mpc.paused && (
        <span className="muted run-counts-next">
          Next MPC {formatSlot(mpc.next_run, now, timeZone)} · {formatCountdown(mpc.next_run, now)}
        </span>
      )}
    </p>
  )
}
