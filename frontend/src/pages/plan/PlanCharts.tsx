import { useCallback, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useGridDetail, useJobs, useMarketCommands, useRuns } from '../../api/queries'
import type { GridDetail, PlanHistoryResponse, PlanResponse, PlanRow, RunSummary } from '../../api/types'
import { ChartHead, type ChartKeyItem } from '../../components/charts/ChartHead'
import { Overview } from '../../components/charts/Overview'
import {
  TimeChart,
  type ChartGap,
  type ChartLane,
  type ChartOverlay,
  type ChartSession,
  type ChartSplit,
  type ChartTick,
} from '../../components/charts/TimeChart'
import { Lamp } from '../../components/Lamp'
import { useNow } from '../../components/useNow'
import { formatClock, formatCountdown, formatSlot } from '../../lib/format'
import { momentLabel } from '../../lib/chartPopup'
import { clampWindow } from '../../lib/chartRange'
import { adaptiveStep } from '../../lib/chartKeys'
import { cursorTimeLabel, dayDateLabel, dayTimeLabel, localMidnights, rangeLabel, spanLabel } from '../../lib/chartTime'
import {
  detailCover,
  detailRequest,
  gridCadence,
  gridDetailNote,
  gridOverlay,
  lastReading,
  planTail,
  readingsPhrase,
} from '../../lib/gridDetail'
import {
  commandSessions,
  marketBlock,
  marketLane,
  marketLead,
  marketOverlay,
  sessionBands,
  sessionWindow,
  shortfallGap,
  shortfalls,
} from '../../lib/market'
import { OUTCOMES, outcomeLabel } from '../../lib/outcomes'
import { blockAt, runBlocks } from '../../lib/runBlocks'
import { pastEnd, thenLabel, timeGrid, viewRange, type HorizonSlots, type ViewHours } from '../../lib/planHistory'
import { PLAN_LINE, planFlows, powerSeries, priceSeries, socSeries, type Flows } from '../../lib/planSeries'
import { energyIn, formatKwh, socSummary } from '../../lib/planTotals'
import { HEAT_STEPS, priceHeatLane, windowExtremes } from '../../lib/prices'
import { eurTick } from '../../lib/units'
import { ChartHints } from './ChartHints'

const SYNC = 'plan'

// Each y-axis hugs its own data; the minimum spans keep near-flat lines from turning into noise.
const POWER_FIT = { minSpan: 500 }
const SOC_FIT = { minSpan: 5, clamp: [0, 100] as [number, number] }
const PRICE_FIT = { minSpan: 0.01 } // €/kWh

function kwTick(v: number): string {
  return `${(v / 1000).toFixed(Math.abs(v) < 10_000 ? 1 : 0)} kW`
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
  horizon = 0,
  zoom,
  onZoom: setZoom,
  loading = false,
}: {
  data: PlanResponse
  history?: PlanHistoryResponse
  nowS: number
  view: ViewHours
  /** Which earlier plan a past slot is compared with. */
  horizon?: HorizonSlots
  /** A window picked by zooming, scrolling or the overview (unix seconds); null follows now. */
  zoom: [number, number] | null
  onZoom: (range: [number, number] | null) => void
  /** A wider window's history is on its way: the charts stay, faded. */
  loading?: boolean
}) {
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
  const tz = data.timezone
  // a hairline at every local midnight; the time axis's labels only under the last chart, with now and the cursor's
  // moment on it
  const midnights = useMemo(
    () => (bounds ? localMidnights(bounds[0] - 86400, bounds[1] + 86400, tz) : []),
    [bounds, tz],
  )
  const nowLabel = `now ${cursorTimeLabel(nowS, tz, false)}`
  const cursorLabel = useCallback(
    (time: number, windowS: number) => cursorTimeLabel(time, tz, time < nowS && windowS <= 12 * 3600),
    [tz, nowS],
  )
  const zoomTo = (range: [number, number] | null) => setZoom(range && bounds ? clampWindow(range, bounds) : null)

  const flows = useMemo<Flows>(() => planFlows(x, past, rows, pastEndS, data.columns), [x, rows, past, pastEndS, data.columns])
  const soc = useMemo(
    () => socSeries(x, past, rows, previous, pastEndS, data.columns, thenLabel(horizon)),
    [x, rows, previous, past, pastEndS, data.columns, horizon],
  )
  const prices = useMemo(() => priceSeries(history?.prices ?? [], data.prices), [history, data.prices])

  // the parts the Power chart's chips switch off, and the grid's readings in the window shown
  const [hidden, setHidden] = useState(loadHidden)
  const toggle = (part: PowerPart) => {
    const next = new Set(hidden)
    if (next.has(part)) next.delete(part)
    else next.add(part)
    setHidden(next)
    saveHidden(next)
  }
  const showGrid = flows.grid !== null && !hidden.has('grid')
  const detail = useGridDetail(shown ? detailRequest(shown, nowS, zoom !== null) : null, showGrid)
  const gridData = showGrid ? detail.data : undefined
  const measuredUntil = lastReading(gridData) ?? (history?.measurements.last_sample_at ? Date.parse(history.measurements.last_sample_at) / 1000 : null)

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
  // what the heads add up for the window shown
  const socNow = useMemo(() => socSummary(x, soc?.[0]?.values ?? [], nowS), [x, soc, nowS])
  const thenName = thenLabel(horizon)
  const socKeys: ChartKeyItem[] = [
    { label: 'measured', color: '--q-soc', look: 'line' },
    ...(soc?.some((s) => s.then) ? [{ label: thenName, color: '--chart-then', look: 'dash' as const }] : []),
    { label: 'plan', color: '--q-soc', look: 'faded' },
    ...(previous.length > 0 ? [{ label: 'previous plan', color: '--ink-faint', look: 'dash' as const }] : []),
  ]
  const extremes = useMemo(() => (prices && shown ? windowExtremes(prices.imports, shown) : null), [prices, shown])
  const heat = useMemo(
    () =>
      prices && shown
        ? [priceHeatLane(prices.imports.map((p) => p.t), prices.imports.map((p) => p.value), 900, shown)]
        : [],
    [prices, shown],
  )
  const priceKeys: ChartKeyItem[] = [
    { label: 'import', color: '--q-import', look: 'line' },
    { label: 'export', color: '--q-export', look: 'line' },
    ...(extremes
      ? [
          {
            label: `${extremes.cheapest.value.toFixed(2)}–${extremes.dearest.value.toFixed(2)}`,
            color: '--heat-3',
            look: 'gradient' as const,
            gradient: Array.from({ length: HEAT_STEPS }, (_, i) => `--heat-${i}`),
            title: 'The import price ribbon under the chart, from the cheapest to the dearest quarter-hour shown',
          },
        ]
      : []),
    ...(prices?.bands.length
      ? [{ label: 'forecast, not yet from Nord Pool', color: '--chart-hatch', look: 'hatch' as const }]
      : []),
  ]
  const forecastHatches = useMemo(
    () => (prices?.bands ?? []).map(([from, to]) => ({ from, to, label: 'forecast' })),
    [prices],
  )
  const runId = data.current?.run_id
  const plannedAt = data.current?.generated_at
  return (
    <div className="chart-stack" data-loading={loading || undefined} aria-busy={loading || undefined}>
      <p className="timeline-intro">
        {measuredUntil !== null && (
          <>
            Measured until <b>{cursorTimeLabel(measuredUntil, tz, false)}</b>,{' '}
            {readingsPhrase(gridData?.step_s, gridCadence(gridData))}; then the plan
          </>
        )}
        {measuredUntil === null && 'The plan'}
        {runId ? (
          <>
            {' '}
            from <Link to={`/runs/${runId}`}>run #{runId}</Link>
          </>
        ) : null}
        {plannedAt && ` (${cursorTimeLabel(Date.parse(plannedAt) / 1000, tz, false)})`}. Times in {tz}.
      </p>
      <PowerChart
        x={x}
        flows={flows}
        hasPast={hasPast}
        zoom={shown}
        hidden={hidden}
        onToggle={toggle}
        gridData={gridData}
        thenName={thenLabel(horizon)}
        onZoom={zoomTo}
        split={ahead}
        markers={midnights}
        nowS={nowS}
        pastEndS={pastEndS}
        timeZone={data.timezone}
        slotTag={slotTag}
      />
      {soc && (
        <section className="chart-block">
          <ChartHead
            title="Battery state of charge"
            unit="%"
            keys={socKeys}
            summary={
              socNow.now !== null || socNow.end !== null ? (
                <>
                  {socNow.now !== null && (
                    <>
                      now <b>{Math.round(socNow.now)} %</b>
                    </>
                  )}
                  {socNow.now !== null && socNow.end !== null && ' · '}
                  {socNow.end !== null && (
                    <>
                      plan reaches <b>{Math.round(socNow.end)} %</b>
                    </>
                  )}
                </>
              ) : undefined
            }
          />
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
            markers={midnights}
            timeAxis="ticks"
            now={nowS}
            timeZone={data.timezone}
            height={150}
            popup={slotTag}
            legend={false}
          />
        </section>
      )}
      {prices && (
        <section className="chart-block">
          <ChartHead
            title="Price"
            unit="€/kWh, fees and VAT included"
            keys={priceKeys}
            summary={
              extremes ? (
                <>
                  cheapest <b>{extremes.cheapest.value.toFixed(3)}</b> at {dayTimeLabel(extremes.cheapest.t, tz)} ·
                  dearest <b>{extremes.dearest.value.toFixed(3)}</b> at {dayTimeLabel(extremes.dearest.t, tz)}
                </>
              ) : undefined
            }
          />
          <TimeChart
            x={prices.x}
            series={prices.series}
            ariaLabel="Import and export price per quarter-hour, with a ribbon of the import price from cheap (light) to dear (deep); shaded where the price is a forecast"
            syncKey={SYNC}
            yFormat={eurTick}
            fit={PRICE_FIT}
            xRange={shown}
            onZoom={zoomTo}
            hatches={forecastHatches}
            markers={midnights}
            timeAxis="ticks"
            now={nowS}
            timeZone={data.timezone}
            height={160}
            popup={{ tag: prices.tag }}
            lanes={heat}
            legend={false}
          />
        </section>
      )}
      <MpcRunStrip
        x={x}
        zoom={shown}
        onZoom={zoomTo}
        nowS={nowS}
        timeZone={data.timezone}
        markers={midnights}
        nowLabel={nowLabel}
        cursorLabel={cursorLabel}
      />
      {bounds && shown && (
        <section className="chart-block">
          <ChartHead
            title="Overview"
            unit={`grid power and market sessions, ${dayDateLabel(bounds[0], tz)} to ${dayDateLabel(bounds[1] - 1, tz)}`}
            summary={
              <>
                showing <b>{rangeLabel(shown[0], shown[1], tz)}</b> ({spanLabel(shown[1] - shown[0])})
              </>
            }
          />
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
      <ChartHints windowS={shown ? shown[1] - shown[0] : 8 * 3600} />
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
  markers,
  nowLabel,
  cursorLabel,
}: {
  x: number[]
  zoom: [number, number] | null
  onZoom: (range: [number, number] | null) => void
  nowS: number
  timeZone: string
  markers: number[]
  nowLabel: string
  cursorLabel: (time: number, windowS: number) => string
}) {
  const navigate = useNavigate()
  // Whole hours keep the query key steady while the chart's first slot moves on
  const first = x[0]
  const since = first !== undefined ? new Date(Math.floor(first / 3600) * 3600 * 1000).toISOString() : undefined
  const runs = useRuns({ job: 'emhass.mpc', since, limit: 1000 })
  const list = useMemo(() => runs.data ?? [], [runs.data])
  const jobs = useJobs()
  const mpc = jobs.data?.find((j) => j.id === 'emhass.mpc')
  const nextRun = mpc?.next_run && !mpc.paused ? Date.parse(mpc.next_run) / 1000 : null
  // each run a block until the next starts, the next one outlined; a chip names the one at the cursor
  const blocks = useMemo(() => runBlocks(list, nextRun), [list, nextRun])
  const ticks = useMemo<ChartTick[]>(
    () =>
      blocks.map((b) => ({
        t: b.from,
        until: b.to,
        color: b.color,
        label: b.label,
        id: b.id ?? undefined,
        outline: b.outline,
      })),
    [blocks],
  )
  const popup = useMemo(
    () => ({
      style: 'chip' as const,
      chip: (_t: number, time: number) => {
        const b = blockAt(blocks, time)
        return b ? [{ text: b.label, color: b.color.replace('--lamp-', '--on-') }] : []
      },
    }),
    [blocks],
  )
  const empty = useMemo(() => [{ label: 'MPC runs', color: 'transparent', values: x.map(() => null) }], [x])
  if (x.length === 0) return null
  return (
    <section className="chart-block run-strip">
      <ChartHead title="MPC runs" summary={<RunCounts runs={list} timeZone={timeZone} />} />
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
        nowLabel={nowLabel}
        cursorLabel={cursorLabel}
        markers={markers}
        timeZone={timeZone}
        height={84}
        ticks={ticks}
        onTick={(tick) => tick.id && navigate(`/runs/${tick.id}`)}
        popup={popup}
      />
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
  hidden,
  onToggle: toggle,
  gridData,
  thenName,
  onZoom,
  split,
  markers,
  nowS,
  pastEndS,
  timeZone,
  slotTag,
}: {
  x: number[]
  flows: Flows
  hasPast: boolean
  zoom: [number, number] | null
  hidden: Set<PowerPart>
  onToggle: (part: PowerPart) => void
  /** The grid's readings in the window shown. */
  gridData: GridDetail | undefined
  /** What the plan the past is compared with is called ("planned then"). */
  thenName: string
  onZoom: (range: [number, number] | null) => void
  split: ChartSplit
  markers: number[]
  nowS: number
  pastEndS: number
  timeZone: string
  slotTag: { tag: (t: number) => { text: string; tone: 'neutral' | 'blue' } }
}) {
  // Whole hours keep the query key steady while the chart's first slot moves on
  const first = x[0]
  const since = first !== undefined ? new Date(Math.floor(first / 3600) * 3600 * 1000).toISOString() : null
  const commands = useMarketCommands(since)
  const spans = useMemo(() => commands.data?.spans ?? [], [commands.data])
  const showPower = spans.length > 0 && !hidden.has('market-power')
  const showSessions = spans.length > 0 && !hidden.has('market-commands')
  const cover = useMemo(() => detailCover(gridData), [gridData])

  const series = useMemo(
    () =>
      powerSeries({
        x,
        flows,
        hidden: (part) => hidden.has(part),
        cover,
        pastEndS,
        nowS,
        gridData,
        thenName,
      }),
    [flows, hidden, cover, x, pastEndS, nowS, gridData, thenName],
  )

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
    // what the moment's value is: a reading, or a mean over a step on a long window
    const cadence = gridCadence(gridData)
    const what = cadence !== null ? ` · ${cadence} s reading` : gridData?.step_s ? ` · mean of ${spanLabel(gridData.step_s)}` : ''
    return {
      ...slotTag,
      // left of now the popup is about the pointer's own moment (the grid's reading, a command); the slot heads the rows
      head:
        gridData || market
          ? (_t: number, time: number) => (time < nowS ? `${momentLabel(time, timeZone, { date: true })}${what}` : null)
          : undefined,
      block: market ? (_t: number, time: number) => block(time) : undefined,
      lead: showPower ? (_t: number, time: number) => marketLead({ spans, time, nowS, timeZone }) : undefined,
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
      <ChartHead
        title="Power"
        unit="kW · above zero: into the house · below: out of it"
        summary={
          zoom && flows.grid ? (
            <>
              imported <b>{formatKwh(energyIn(x, flows.grid, zoom, 1))}</b> · exported{' '}
              <b>{formatKwh(energyIn(x, flows.grid, zoom, -1))}</b>
              {flows.pv && (
                <>
                  {' '}
                  · PV <b>{formatKwh(energyIn(x, flows.pv, zoom, 0))}</b>
                </>
              )}
            </>
          ) : undefined
        }
      />
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
        markers={markers}
        timeAxis="ticks"
        now={nowS}
        timeZone={timeZone}
        height={bands.length > 0 ? 335 : 286}
        popup={popup}
        legend={false}
        overlays={overlays}
        gaps={gaps}
        lanes={lanes}
        sessions={bands}
        onSession={zoomToSession}
        keyboard={{ step: adaptiveStep, home: nowS }}
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
            grid, {thenName}
          </li>
        )}
        {flows.grid && (
          <li className="legend-key" title="Right of the now line: the grid as the plan has it">
            <span className="legend-line" data-faded aria-hidden="true" />
            grid plan
          </li>
        )}
        {spans.length > 0 && zoom && !sessions.some((s) => s.to > zoom[0] && s.from < zoom[1]) && (
          <li className="legend-key legend-empty">No market sessions between {rangeLabel(zoom[0], zoom[1], timeZone)}</li>
        )}
        {showSessions && (
          <>
            <li className="legend-key">
              <span className="legend-square" style={{ background: 'var(--q-sell)' }} aria-hidden="true" />
              sell
            </li>
            <li className="legend-key">
              <span className="legend-square" style={{ background: 'var(--q-buy)' }} aria-hidden="true" />
              buy
            </li>
          </>
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
    <span className="run-counts">
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
    </span>
  )
}
