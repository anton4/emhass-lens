import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useGridDetail, useJobs, useMarketCommands, useRuns } from '../../api/queries'
import type { PlanHistoryResponse, PlanPrice, PlanResponse, PlanRow, RunSummary } from '../../api/types'
import {
  TimeChart,
  type ChartGap,
  type ChartLane,
  type ChartOverlay,
  type ChartSeries,
  type ChartSession,
  type ChartTick,
} from '../../components/charts/TimeChart'
import { Lamp } from '../../components/Lamp'
import { useNow } from '../../components/useNow'
import { formatClock, formatCountdown, formatSlot } from '../../lib/format'
import { momentLabel } from '../../lib/chartPopup'
import { detailCover, detailRequest, gridDetailNote, gridOverlay, gridRows, withoutCovered } from '../../lib/gridDetail'
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
import { snapWindow } from '../../lib/chartRange'
import { alignTo, deferrableColumns, hasColumn, socColumns } from '../../lib/plan'
import { IDLE_W } from '../../lib/planSummary'
import { isForecast, originLabel } from '../../lib/prices'
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

// Power quantities, each in its own colour on every chart: battery, grid, PV (an area), load; the deferrable loads
// follow. The battery is drawn with charging up (EMHASS counts discharging as positive), like the grid's import.
const POWER = [
  {
    column: 'P_batt',
    measured: 'batt',
    planned: 'P_batt',
    label: 'Battery',
    popupLabel: 'Battery',
    color: '--q-batt',
    fill: undefined,
    flip: true,
    format: formatSignedPower,
    describe: charging,
  },
  {
    column: 'P_grid',
    measured: 'grid',
    planned: 'P_grid',
    label: 'Grid',
    popupLabel: 'Grid',
    color: '--q-grid',
    fill: undefined,
    flip: false,
    format: formatSignedPower,
    describe: importing,
  },
  {
    column: 'P_PV',
    measured: 'pv',
    planned: 'P_PV',
    label: 'PV',
    popupLabel: 'PV',
    color: '--q-pv',
    fill: 0.16,
    flip: false,
    format: formatPower,
    describe: undefined,
  },
  {
    column: 'P_Load',
    measured: 'load',
    planned: 'P_Load',
    label: 'House load',
    popupLabel: 'House load',
    color: '--q-load',
    fill: undefined,
    flip: false,
    format: formatPower,
    describe: undefined,
  },
] as const

const DASHED = { width: 1.5, dash: [4, 4] as number[] }

/** What the Power chart's chips switch: a quantity (its measured, planned and planned-then lines; the grid's measured
 *  line is the grid power finer than the slots where there is one), the deferrable loads, and Qilowatt's commands: the
 *  commanded power with its shortfalls ('market-power'), and the sessions as bands, flags and a lane
 *  ('market-commands'). */
type PowerPart = 'batt' | 'grid' | 'pv' | 'load' | 'deferrable' | 'market-power' | 'market-commands'

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
}

const negated = (values: (number | null)[]) => values.map((v) => (v === null ? null : -v))

/** Power, state of charge and prices on one synced time axis: measured history (solid) with what the plan
 *  said at the time (dashed) left of the now line, the current plan right of it. */
export function PlanCharts({
  data,
  history,
  nowS,
}: {
  data: PlanResponse
  history?: PlanHistoryResponse
  nowS: number
}) {
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
    const parts: { chip: PowerChip; series: ChartSeries[] }[] = []
    for (const q of POWER) {
      const inPlan = hasColumn(rows, q.column)
      const measured = hasMeasured(past, q.measured)
      const planned = hasPlanned(past, q.planned)
      if (!inPlan && !measured && !planned) continue
      const values = pastAndFuture(x, past, q.measured, rows, q.column, pastEndS)
      const series: ChartSeries[] = [
        {
          label: q.label,
          popupLabel: q.popupLabel,
          color: q.color,
          fill: q.fill,
          values: q.flip ? negated(values) : values,
          format: q.format,
          describe: q.describe,
        },
      ]
      if (planned) {
        const then = plannedAtTheTime(x, past, q.planned)
        series.push({
          label: `${q.label}, planned at the time`,
          color: q.color,
          ...DASHED,
          values: q.flip ? negated(then) : then,
          format: q.format,
          then: true,
        })
      }
      parts.push({ chip: { part: q.measured, label: q.label, color: q.color }, series })
    }
    const deferrables = deferrableColumns(data.columns)
    const plannedDeferrable = hasPlanned(past, 'P_deferrable')
    if (deferrables.length > 0 || plannedDeferrable) {
      const label = deferrables.length === 1 ? 'Deferrable load' : 'Deferrable loads'
      const series: ChartSeries[] = [
        {
          label,
          color: '--q-ev',
          values: deferrableFuture(x, rows, deferrables, pastEndS),
          format: formatPower,
        },
      ]
      if (plannedDeferrable) {
        series.push({
          label: `${label}, planned at the time`,
          color: '--q-ev',
          ...DASHED,
          values: plannedAtTheTime(x, past, 'P_deferrable'),
          format: formatPower,
          then: true,
        })
      }
      parts.push({ chip: { part: 'deferrable', label, color: '--q-ev' }, series })
    }
    return parts
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
      color: '--q-soc',
      step: false,
      values: pastAndFuture(x, past, 'soc', rows, first, pastEndS, 100, false),
      format: fmt,
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
    return { x: px, series, bands: forecastBands(slots), shade: pastShade(px, pastEndS), tag }
  }, [history, data.prices, pastEndS])

  const hasPast = past.length > 0
  // the popup's tag: measured left of the now line, the plan right of it
  const slotTag = {
    tag: (t: number) =>
      t < pastEndS ? { text: 'measured', tone: 'neutral' as const } : { text: 'plan', tone: 'blue' as const },
  }
  return (
    <div className="chart-stack">
      <p className="chart-note chart-zoom" role="status">
        {zoom && (
          <>
            Showing {windowLabel(zoom, data.timezone)}
            <button type="button" className="quiet" onClick={() => setZoom(null)}>
              Reset zoom
            </button>
          </>
        )}
      </p>
      <PowerChart
        x={x}
        parts={power}
        hasPast={hasPast}
        measuredGrid={hasMeasured(past, 'grid')}
        zoom={zoom}
        onZoom={zoomTo}
        shade={shade}
        nowS={nowS}
        pastEndS={pastEndS}
        timeZone={data.timezone}
        slotTag={slotTag}
      />
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
            height={210}
            popup={slotTag}
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
            xRange={zoom}
            onZoom={zoomTo}
            bands={prices.bands}
            shade={prices.shade}
            now={nowS}
            timeZone={data.timezone}
            height={210}
            popup={{ tag: prices.tag }}
          />
          {prices.bands.length > 0 && (
            <p className="chart-note">Shaded: forecast prices, not yet published by Nord Pool.</p>
          )}
        </section>
      )}
      <MpcRunStrip x={x} zoom={zoom} onZoom={zoomTo} shade={shade} nowS={nowS} timeZone={data.timezone} />
    </div>
  )
}

/** The MPC runs on the same time axis as the charts, coloured by outcome; a click opens the run. */
function MpcRunStrip({
  x,
  zoom,
  onZoom,
  shade,
  nowS,
  timeZone,
}: {
  x: number[]
  zoom: [number, number] | null
  onZoom: (range: [number, number] | null) => void
  shade: [number, number][]
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
        shade={shade}
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

/** The Power chart: battery, grid, PV, house load and the deferrable loads, with the grid measured finer than the slots
 *  left of now where there is a grid sensor, and Qilowatt's commands from the Home Assistant recorder: each session a
 *  band with a flag and a bar in the lane under the chart (a click zooms to it), the commanded power as an ink line on
 *  the same steps as the measured grid, and where the grid fell short of it, hatched. Chips under it switch each part. */
function PowerChart({
  x,
  parts,
  hasPast,
  measuredGrid,
  zoom,
  onZoom,
  shade,
  nowS,
  pastEndS,
  timeZone,
  slotTag,
}: {
  x: number[]
  parts: { chip: PowerChip; series: ChartSeries[] }[]
  hasPast: boolean
  measuredGrid: boolean
  zoom: [number, number] | null
  onZoom: (range: [number, number] | null) => void
  shade: [number, number][]
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
  // the measured part of the window shown, finer than the slots: the grid's line there
  const last = x[x.length - 1]
  const shown: [number, number] | null = zoom ?? (first !== undefined && last !== undefined ? [first, last] : null)
  const showDetail = measuredGrid && !hidden.has('grid')
  const detail = useGridDetail(shown ? detailRequest(shown, nowS, zoom !== null) : null, showDetail)
  const gridData = showDetail ? detail.data : undefined
  const cover = useMemo(() => detailCover(gridData), [gridData])
  const series = useMemo(
    () =>
      parts
        .filter((p) => !hidden.has(p.chip.part))
        .flatMap((p) =>
          p.chip.part === 'grid' && cover
            ? p.series.map((line, i) =>
                // the measured quarter-hours the detail covers are drawn by its line; the popup keeps their means
                i === 0 ? { ...line, values: withoutCovered(x, line.values, cover, pastEndS), readout: line.values } : line,
              )
            : p.series,
        ),
    [parts, hidden, cover, x, pastEndS],
  )
  const sessions = useMemo(() => commandSessions(spans, nowS), [spans, nowS])
  const runs = useMemo(() => (showPower ? shortfalls(spans, gridData, nowS) : []), [showPower, spans, gridData, nowS])
  // the measured grid's thin line on top of the bold commanded one, so both show where they agree
  const overlays = useMemo<ChartOverlay[]>(
    () => [
      ...(showPower ? [marketOverlay(spans, nowS)] : []),
      ...(gridData && gridData.points.length > 0 ? [gridOverlay(gridData)] : []),
    ],
    [gridData, showPower, spans, nowS],
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
      // left of now the popup is about the pointer's own moment (the measured grid, a command); the slot heads the rows
      head: gridData || market ? (_t: number, time: number) => (time < nowS ? momentLabel(time, timeZone) : null) : undefined,
      block: market ? (_t: number, time: number) => block(time) : undefined,
      // the measured grid at the pointer, unless the command's block has it
      extra: gridData ? (_t: number, time: number) => (block(time) ? [] : gridRows(gridData, time)) : undefined,
    }
  }, [slotTag, gridData, showPower, showSessions, spans, sessions, runs, nowS, timeZone])
  const zoomToSession = (id: string) => {
    const session = sessions.find((s) => s.id === id)
    if (session) onZoom(sessionWindow(session))
  }
  const detailNote = gridDetailNote(gridData?.step_s)
  const gridTitle = gridData?.error
    ? gridData.error
    : detailNote
      ? `Left of now ${detailNote}, the plan right of it`
      : undefined
  const chips = parts.map((p) => p.chip)
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
      <h3>Power</h3>
      <TimeChart
        x={x}
        series={series}
        ariaLabel="Power per quarter-hour: measured history and the plan for battery, grid, PV, house load and deferrable loads, the grid power measured in detail, and the market's sessions and commanded power"
        syncKey={SYNC}
        yFormat={kwTick}
        fit={POWER_FIT}
        xRange={zoom}
        onZoom={onZoom}
        shade={shade}
        now={nowS}
        timeZone={timeZone}
        height={bands.length > 0 ? 326 : 300}
        popup={popup}
        legend={false}
        overlays={overlays}
        gaps={gaps}
        lanes={lanes}
        sessions={bands}
        onSession={zoomToSession}
      />
      <ul className="legend" role="group" aria-label="Lines shown in the Power chart">
        {chips.map((c) => chip(c, c.part === 'grid' ? gridTitle : undefined))}
        {marketChips.length > 0 && (
          <li className="legend-group" aria-hidden="true">
            Market
          </li>
        )}
        {marketChips.map((c) => chip(c))}
        {hasPast && (
          <li className="legend-key" title="Left of the now line, solid lines are measured; right of it, the current plan">
            <span className="legend-dash" aria-hidden="true" />
            planned at the time
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
