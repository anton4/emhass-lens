import { useMutation } from '@tanstack/react-query'
import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { api, query } from '../../api/client'
import { useSentInputs } from '../../api/queries'
import type { SentInputs } from '../../api/types'
import { TimeChart, type ChartNote, type ChartSeries } from '../../components/charts/TimeChart'
import type { PopupTag } from '../../components/charts/cursorStore'
import { Empty, ErrorNotice } from '../../components/PageHead'
import { snapWindow } from '../../lib/chartRange'
import { outcomeLabel } from '../../lib/outcomes'
import { closeSteps, loadPref, savePref } from '../../lib/planHistory'
import { isForecast, originLabel } from '../../lib/prices'
import {
  deferrableLanes,
  exportLane,
  forecastRangesOn,
  kwhOf,
  loadAsk,
  loadExtras,
  midnightsOn,
  onAxis,
  priceExtras,
  pvDays,
  pvNotes,
  sentAxis,
  SLOT_S,
  slotAt,
  tariffLane,
} from '../../lib/sent'
import { eurTick, formatAge, formatPower, isNumber, priceFactor, type PriceUnit } from '../../lib/units'

const SYNC = 'sent'
const HOURS_BACK_KEY = 'emhass-lens.inputs.hours-back'
const HOURS_BACK = [0, 24] as const

const POWER_FIT = { minSpan: 500 }
// room above the highest hump for its day's total
const PV_FIT = { minSpan: 500, pad: 0.2, zero: true, clamp: [0, null] as [number, null] }
const PRICE_FIT = { minSpan: 0.01 }

const MEASURED: PopupTag = { text: 'measured', tone: 'neutral' }

const dayTimes = new Map<string, Intl.DateTimeFormat>()
/** "Sun 21:00" in the tariff time zone. */
function dayTime(t: number, timeZone: string): string {
  let f = dayTimes.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    dayTimes.set(timeZone, f)
  }
  return f.format(new Date(t * 1000))
}

/** An entity id or payload key that may wrap after its dots and underscores. */
function Breakable({ text }: { text: string }) {
  const parts = text.split(/(?<=[._])/)
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part}
          {i < parts.length - 1 && <wbr />}
        </Fragment>
      ))}
    </>
  )
}

const percent = (v: number | null | undefined) => (isNumber(v) ? `${Math.round(v * 100)} %` : '—')
const kwTick = (v: number) => `${(v / 1000).toFixed(Math.abs(v) < 10_000 ? 1 : 0)} kW`
const provider = (origin: string) => originLabel(origin).replace(/^Forecast \((.*)\)$/, '$1')

/** The Inputs page's "What EMHASS gets": the newest MPC payload (or one built now) slot by slot, on one time axis
 *  after what was measured before its anchor, every chart with the Plan page's value popup. */
export function SentPanel({ unit, nowS }: { unit: PriceUnit; nowS: number }) {
  const [hoursBack, setHoursBackState] = useState<number>(() => loadPref(HOURS_BACK_KEY, HOURS_BACK, 24))
  const [source, setSource] = useState<'last_run' | 'preview'>('last_run')
  const last = useSentInputs(hoursBack)
  const preview = useMutation({
    mutationFn: (hours: number) => api.post<SentInputs>(`/api/inputs/sent/preview${query({ hours_back: hours })}`),
  })
  const data = source === 'preview' ? preview.data : last.data
  const [zoom, setZoom] = useState<[number, number] | null>(null)
  const zoomTo = (range: [number, number] | null) => setZoom(range && snapWindow(range, SLOT_S))

  const setHoursBack = (hours: number) => {
    setHoursBackState(hours)
    savePref(HOURS_BACK_KEY, hours)
    setZoom(null)
    if (source === 'preview') preview.mutate(hours)
  }
  const showPreview = () => {
    setSource('preview')
    setZoom(null)
    preview.mutate(hoursBack)
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-title-row">
          <h2>What EMHASS gets</h2>
          {data?.available && <span className="muted">times in {data.timezone}</span>}
        </div>
        <div className="segmented" role="group" aria-label="Payload">
          <button type="button" aria-pressed={source === 'last_run'} onClick={() => setSource('last_run')}>
            {last.data?.run_id ? `Last run #${last.data.run_id}` : 'Last run'}
          </button>
          <button type="button" aria-pressed={source === 'preview'} onClick={showPreview}>
            Preview now
          </button>
        </div>
      </div>
      <div className="panel-body">
        <ErrorNotice error={source === 'preview' ? preview.error : last.error} />
        {source === 'preview' && preview.isPending && <p className="muted">Building…</p>}
        {data && !data.available && (
          <Empty title="No MPC run yet">
            The newest run&rsquo;s payload shows here. Preview now builds one as if a run started now, without sending it.
          </Empty>
        )}
        {data?.available && (
          <SentView
            data={data}
            unit={unit}
            nowS={nowS}
            zoom={zoom}
            zoomTo={zoomTo}
            hoursBack={hoursBack}
            setHoursBack={setHoursBack}
            rebuild={source === 'preview' ? () => preview.mutate(hoursBack) : undefined}
          />
        )}
      </div>
    </section>
  )
}

function SentView({
  data,
  unit,
  nowS,
  zoom,
  zoomTo,
  hoursBack,
  setHoursBack,
  rebuild,
}: {
  data: SentInputs
  unit: PriceUnit
  nowS: number
  zoom: [number, number] | null
  zoomTo: (range: [number, number] | null) => void
  hoursBack: number
  setHoursBack: (hours: number) => void
  rebuild?: () => void
}) {
  const tz = data.timezone
  const charts = useMemo(() => buildCharts(data, unit), [data, unit])
  const { axis } = charts
  const shade: [number, number][] = axis.anchorIdx > 0 ? [[axis.x[0] ?? axis.anchorS, axis.anchorS]] : []
  const now = nowS >= (axis.x[0] ?? 0) && nowS <= axis.endS ? nowS : undefined
  const common = {
    x: axis.x,
    syncKey: SYNC,
    timeZone: tz,
    xRange: zoom,
    onZoom: zoomTo,
    shade,
    markers: charts.midnights,
    now,
    snapToSlot: true,
  }
  const measuredBy = (q: string) => data.measured_entities[q]

  return (
    <>
      <p className="muted sent-source">
        <span>
          <SourceNote data={data} />
        </span>
        {rebuild && (
          <button type="button" className="quiet" onClick={rebuild}>
            Build again
          </button>
        )}
      </p>
      <SentCards data={data} />

      <div className="sent-toolbar">
        <p className="chart-note chart-zoom" role="status">
          {zoom ? (
            <>
              Zoomed in
              <button type="button" className="quiet" onClick={() => zoomTo(null)}>
                Reset zoom
              </button>
            </>
          ) : (
            'Point at a chart to read every chart at that quarter-hour. Drag across one to zoom in; double-click to see it all.'
          )}
        </p>
        <div className="sent-back">
          <span className="muted">Before the anchor</span>
          <div className="segmented" role="group" aria-label="Measured before the anchor">
            <button type="button" aria-pressed={hoursBack === 0} onClick={() => setHoursBack(0)}>
              Off
            </button>
            <button type="button" aria-pressed={hoursBack === 24} onClick={() => setHoursBack(24)}>
              24 h measured
            </button>
          </div>
        </div>
      </div>

      <div className="chart-stack">
        <section className="chart-block">
          <h3>Prices sent</h3>
          <TimeChart
            {...common}
            series={charts.prices}
            ariaLabel="Import and export price per quarter-hour: those that applied before the anchor and those sent to EMHASS after it, with the tariff period and the export limit under the chart"
            yFormat={(v) => (unit === 'cents' ? `${v.toFixed(0)} c` : eurTick(v))}
            fit={PRICE_FIT}
            bands={charts.forecast}
            height={230}
            lanes={charts.priceLanes}
            popup={charts.pricePopup}
          />
          <p className="chart-note">
            <code>load_cost_forecast</code> and <code>prod_price_forecast</code>, fees included and the import price with
            VAT.{charts.forecast.length > 0 && ' Shaded: forecast prices.'}
            {charts.hasPastPrices &&
              hoursBack > 0 &&
              ' Before the anchor: the Nord Pool prices that applied, with today’s tariff (nothing is sent for past slots).'}
            {isNumber(data.no_export_at_or_below) &&
              ` Export is capped at 0 W where the export price is at or below ${data.no_export_at_or_below} €/kWh (maximum_power_to_grid).`}
          </p>
        </section>

        <section className="chart-block">
          <h3>PV forecast sent</h3>
          <TimeChart
            {...common}
            series={charts.pv}
            ariaLabel="PV measured before the anchor and the Solcast forecast sent to EMHASS after it, per quarter-hour, with each day's total"
            yFormat={kwTick}
            fit={PV_FIT}
            height={210}
            notes={charts.pvNotes}
            popup={charts.sentPopup}
          />
          <p className="chart-note">
            <code>pv_power_forecast</code>
            {charts.hasP10 && (
              <>
                {' '}
                and <code>pv_power_forecast_p10</code>
              </>
            )}{' '}
            from Solcast. Above each day: its total{charts.hasP10 && ', and the P10 total for forecast days'}.
            {charts.hasReserve && ' The EV area is PV held back for the car: EMHASS doesn’t get it.'}
            {data.pv_slots_missing > 0 && ` ${data.pv_slots_missing} slots had no Solcast value and were sent as 0 W.`}
            {measuredBy('pv') && hoursBack > 0 && <> Before the anchor: <code>{measuredBy('pv')}</code>.</>}
          </p>
        </section>

        <section className="chart-block">
          <h3>House load</h3>
          <TimeChart
            {...common}
            series={charts.load}
            ariaLabel="House load measured before the anchor and EMHASS's forecast after it, per quarter-hour, with each deferrable load's window under the chart"
            yFormat={kwTick}
            fit={POWER_FIT}
            height={200}
            lanes={charts.loadLanes}
            popup={charts.loadPopup}
          />
          <p className="chart-note">
            <LoadNote data={data} />
            {measuredBy('load') && hoursBack > 0 && <> Before the anchor: <code>{measuredBy('load')}</code>.</>}
            {data.deferrables
              .filter((d) => !d.on)
              .map((d) => (
                <span key={d.name}>
                  {' '}
                  {d.name} is off{d.enabled_source && <> (<code>{d.enabled_source}</code>)</>}: sent as 0 W for 0 h.
                </span>
              ))}
          </p>
        </section>

        <section className="chart-block">
          <h3>Battery</h3>
          <TimeChart
            {...common}
            series={charts.soc}
            ariaLabel="Battery state of charge measured before the anchor, the state of charge sent at the anchor and the target at the end of the horizon"
            yFormat={(v) => `${v.toFixed(0)} %`}
            yRange={[0, 100]}
            height={160}
            notes={charts.socNotes}
            popup={charts.socPopup}
          />
          <p className="chart-note">
            <code>soc_init</code>
            {data.soc_init_reading && <> from <code>{data.soc_init_reading.source}</code>{ageOf(data.soc_init_reading.age_s)}</>}, and{' '}
            <code>soc_final</code>, the target at the end of the horizon
            {data.soc_final_reading && <>, from <code>{data.soc_final_reading.source}</code></>}. EMHASS plans the path between them.
            {measuredBy('soc') && hoursBack > 0 && <> Before the anchor: <code>{measuredBy('soc')}</code>.</>}
          </p>
        </section>
      </div>
    </>
  )
}

function ageOf(seconds: number | null | undefined): string {
  return isNumber(seconds) ? `, ${formatAge(seconds)} old` : ''
}

function SourceNote({ data }: { data: SentInputs }) {
  const tz = data.timezone
  const anchor = data.anchor ? dayTime(Date.parse(data.anchor) / 1000, tz) : '—'
  const at = data.sent_at ? dayTime(Date.parse(data.sent_at) / 1000, tz) : '—'
  if (data.source === 'preview') {
    return <>Built at {at} as if a run started now, from the anchor {anchor}; nothing is sent to EMHASS.</>
  }
  const sent = data.run_mode === 'live' ? 'sent' : `built (${(data.run_mode ?? 'dry run').replace('_', ' ')}, not sent)`
  const outcome = data.run_outcome && !['ok', 'dry_run', 'shadow'].includes(data.run_outcome) ? data.run_outcome : null
  return (
    <>
      What <Link to={`/runs/${data.run_id}`}>run #{data.run_id}</Link> {sent} at {at}
      {outcome && ` (${outcomeLabel(outcome).toLowerCase()})`}, from the anchor {anchor} to the end of the horizon.
    </>
  )
}

function LoadNote({ data }: { data: SentInputs }) {
  const m = data.model
  if (data.load_source === 'sent') {
    return (
      <>
        Sent as <code>load_power_forecast</code> (Settings → EMHASS → Extra runtime parameters).
      </>
    )
  }
  const learns = (
    <>
      EMHASS forecasts the house load itself: its {m?.method ?? 'ML'} model learns from{' '}
      {m?.historic_days ? `the last ${m.historic_days} days of ` : ''}
      <code>{m?.var_model ?? 'the load sensor'}</code>; Lens doesn&rsquo;t send a load forecast.
    </>
  )
  if (data.load_source === 'none') return <>{learns} No EMHASS plan covers these slots yet.</>
  const made = data.load_plan_generated_at ? dayTime(Date.parse(data.load_plan_generated_at) / 1000, data.timezone) : null
  return (
    <>
      {learns} Shown: the forecast in EMHASS&rsquo;s plan{made && ` of ${made}`}
      {data.load_plan_run_id && data.load_plan_run_id !== data.run_id && ` (run #${data.load_plan_run_id})`}.
    </>
  )
}

function Card({ title, value, sub, keys }: { title: string; value: string; sub: ReactNode; keys: string[] }) {
  return (
    <div className="card">
      <div className="card-title muted">{title}</div>
      <div className="card-value">{value}</div>
      <div className="cell-sub">{sub}</div>
      <div className="sent-keys">
        {keys.map((k) => (
          <code key={k}>
            <Breakable text={k} />
          </code>
        ))}
      </div>
    </div>
  )
}

function SentCards({ data }: { data: SentInputs }) {
  const tz = data.timezone
  const slots = data.slots
  const first = slots[0]
  const anchorS = first ? Date.parse(first.start) / 1000 : 0
  const endS = anchorS + slots.length * SLOT_S
  const actual = slots.filter((s) => !isForecast(s.origin)).length
  const forecastSlot = slots.find((s) => isForecast(s.origin))
  const forecastFrom = forecastSlot ? Date.parse(forecastSlot.start) / 1000 : null
  const pvKwh = kwhOf(slots.map((s) => s.pv_w))
  const hasP10 = slots.some((s) => isNumber(s.pv_p10_w))
  const p10Kwh = kwhOf(slots.map((s) => s.pv_p10_w))
  const loads = data.deferrables
  const one = loads.length === 1 ? loads[0] : undefined
  const m = data.model
  return (
    <div className="cards sent-cards">
      <Card
        title="Horizon"
        value={`${slots.length} slots`}
        sub={`${(slots.length / 4).toFixed(slots.length % 4 ? 2 : 0)} h, ${dayTime(anchorS, tz)} → ${dayTime(endS, tz)}`}
        keys={['prediction_horizon']}
      />
      <Card
        title="Prices"
        value={forecastSlot ? `${actual} + ${slots.length - actual}` : `${actual}`}
        sub={
          forecastSlot && forecastFrom !== null
            ? `Nord Pool to ${dayTime(forecastFrom, tz)}, then ${provider(forecastSlot.origin)}`
            : 'All from Nord Pool'
        }
        keys={['load_cost_forecast', 'prod_price_forecast']}
      />
      <Card
        title="PV forecast"
        value={`${pvKwh.toFixed(1)} kWh`}
        sub={
          <>
            Solcast, {data.pv_sensors} day sensors{hasP10 && ` · P10 ${p10Kwh.toFixed(1)} kWh`}
            {data.pv_slots_missing > 0 && ` · ${data.pv_slots_missing} slots missing`}
          </>
        }
        keys={hasP10 ? ['pv_power_forecast', 'pv_power_forecast_p10'] : ['pv_power_forecast']}
      />
      <Card
        title="Battery"
        value={`${percent(data.soc_init)} → ${percent(data.soc_final)}`}
        sub="now → the target at the end of the horizon"
        keys={['soc_init', 'soc_final']}
      />
      {data.load_source === 'sent' ? (
        <Card title="House load" value="Sent" sub="From the extra runtime parameters" keys={['load_power_forecast']} />
      ) : (
        <Card
          title="House load"
          value={m?.historic_days ? `ML, ${m.historic_days} days` : 'ML'}
          sub={
            <>
              EMHASS learns it from{' '}
              {m?.var_model ? (
                <code>
                  <Breakable text={m.var_model} />
                </code>
              ) : (
                'the load sensor'
              )}
            </>
          }
          keys={['var_model', 'num_lags']}
        />
      )}
      <Card
        title="Deferrable loads"
        value={loads.length === 0 ? 'None' : one ? `${one.name} ${one.on ? 'on' : 'off'}` : `${loads.filter((d) => d.on).length} of ${loads.length} on`}
        sub={
          loads.length === 0
            ? 'None set up'
            : one
              ? one.on
                ? `${loadAsk(one)}${one.end_timesteps > 0 ? ` by ${dayTime(anchorS + one.end_timesteps * SLOT_S, tz)}` : ''}`
                : isNumber(one.configured_power_w)
                  ? `${formatPower(one.configured_power_w)} for ${one.configured_hours ?? 0} h when on`
                  : 'Sent as 0 W'
              : loads.map((d) => d.name).join(', ')
        }
        keys={['number_of_deferrable_loads']}
      />
    </div>
  )
}

function buildCharts(data: SentInputs, unit: PriceUnit) {
  const axis = sentAxis(data)
  const tz = data.timezone
  const slots = data.slots
  const f = priceFactor(unit)
  const priceFormat = unit === 'cents' ? (v: number) => `${v.toFixed(1)} c/kWh` : (v: number) => `${v.toFixed(3)} €/kWh`
  const sentTag = (text: string) => (t: number): PopupTag => (t < axis.anchorS ? MEASURED : { text, tone: 'blue' })

  // before the anchor: the prices that applied (nothing is sent for past slots)
  const scaled = (v: number | null | undefined) => (isNumber(v) ? v * f : null)
  const importValues = onAxis(axis, data.measured.map((m) => scaled(m.load_cost)), slots.map((s) => s.load_cost * f))
  const exportValues = onAxis(axis, data.measured.map((m) => scaled(m.prod_price)), slots.map((s) => s.prod_price * f))
  const prices: ChartSeries[] = [
    { label: 'Import', color: '--q-import', values: closeSteps(importValues), readout: importValues, format: priceFormat },
    { label: 'Export', color: '--q-export', values: closeSteps(exportValues), readout: exportValues, format: priceFormat },
  ]
  const exportRow = exportLane(axis, data)
  const pricePopup = {
    tag: (t: number): PopupTag | null => {
      const i = slotAt(axis, t)
      if (i < 0) return isNumber(data.measured[axis.anchorIdx + i]?.load_cost) ? { text: originLabel('actual'), tone: 'neutral' } : null
      const slot = slots[i]
      return slot ? { text: originLabel(slot.origin), tone: isForecast(slot.origin) ? 'blue' : 'neutral' } : null
    },
    extra: (t: number) => priceExtras(axis, data, t),
  }

  const pvValues = onAxis(
    axis,
    data.measured.map((m) => m.pv),
    slots.map((s) => s.pv_w),
  )
  const p10Values = onAxis(axis, null, slots.map((s) => s.pv_p10_w))
  const hasP10 = p10Values.some((v) => v !== null)
  const hasReserve = slots.some((s) => (s.ev_reserved_w ?? 0) > 0)
  const pv: ChartSeries[] = [{ label: 'PV', color: '--q-pv', fill: 0.16, values: closeSteps(pvValues), readout: pvValues, format: formatPower }]
  if (hasP10) {
    pv.push({ label: 'P10', color: '--q-pv', dash: [4, 3], width: 1.5, values: closeSteps(p10Values), readout: p10Values, format: formatPower })
  }
  if (hasReserve) {
    const reserved = onAxis(axis, null, slots.map((s) => ((s.ev_reserved_w ?? 0) > 0 ? (s.ev_reserved_w ?? 0) : null)))
    pv.push({
      label: 'Held for the EV',
      popupLabel: 'EV reserve',
      color: '--q-ev',
      below: 0,
      fill: 0.35,
      width: 1,
      values: closeSteps(onAxis(axis, null, slots.map((s) => ((s.ev_reserved_w ?? 0) > 0 ? s.pv_w + (s.ev_reserved_w ?? 0) : null)))),
      readout: reserved,
      format: formatPower,
    })
  }

  const loadValues = onAxis(
    axis,
    data.measured.map((m) => m.load),
    data.load_w,
  )
  const load: ChartSeries[] = [
    { label: 'House load', color: '--q-load', values: closeSteps(loadValues), readout: loadValues, format: formatPower },
  ]
  const loadTag = data.load_source === 'plan' ? 'EMHASS forecast' : 'sent'

  const socValues = onAxis(
    axis,
    data.measured.map((m) => (isNumber(m.soc) ? m.soc * 100 : null)),
    null,
  )
  const soc: ChartSeries[] = [
    { label: 'State of charge', color: '--q-soc', values: closeSteps(socValues), readout: socValues, format: (v) => `${v.toFixed(0)} %` },
  ]
  const socNotes: ChartNote[] = []
  if (isNumber(data.soc_init)) {
    socNotes.push({ t: axis.anchorS, value: data.soc_init * 100, text: percent(data.soc_init), color: '--q-soc', dot: 'filled', align: 'right' })
  }
  if (isNumber(data.soc_final)) {
    socNotes.push({ t: axis.endS, value: data.soc_final * 100, text: `${percent(data.soc_final)} target`, color: '--q-soc', dot: 'ring', align: 'left' })
  }

  return {
    axis,
    midnights: midnightsOn(axis, tz),
    forecast: forecastRangesOn(axis, data),
    prices,
    hasPastPrices: data.measured.some((m) => isNumber(m.load_cost)),
    priceLanes: exportRow ? [tariffLane(axis, data), exportRow] : [tariffLane(axis, data)],
    pricePopup,
    pv,
    hasP10,
    hasReserve,
    pvNotes: pvNotes(pvDays(axis, pvValues, p10Values, tz)),
    sentPopup: { tag: sentTag('sent') },
    load,
    loadLanes: deferrableLanes(axis, data.deferrables),
    loadPopup: { tag: sentTag(loadTag), extra: (t: number) => loadExtras(axis, data.deferrables, t) },
    soc,
    socNotes,
    socPopup: {
      tag: sentTag('sent'),
      extra: (t: number) =>
        t < axis.anchorS
          ? []
          : [
              { name: 'Now (soc_init)', value: percent(data.soc_init), color: '--q-soc' },
              { name: 'Target (soc_final)', value: percent(data.soc_final), color: '--q-soc' },
            ],
    },
  }
}
