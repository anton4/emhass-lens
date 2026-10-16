import { useMutation } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useSetExtendDays } from '../../api/actions'
import { api, query } from '../../api/client'
import { useSentInputs, useSettings, useStatus } from '../../api/queries'
import type { HorizonOption, SentInputs } from '../../api/types'
import { ChartHead } from '../../components/charts/ChartHead'
import { TimeChart, type ChartNote, type ChartSeries } from '../../components/charts/TimeChart'
import type { PopupTag } from '../../components/charts/cursorStore'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Empty, ErrorNotice } from '../../components/PageHead'
import { snapWindow } from '../../lib/chartRange'
import { keyHint } from '../../lib/chartKeys'
import { cursorTimeLabel } from '../../lib/chartTime'
import { outcomeLabel } from '../../lib/outcomes'
import { closeSteps, loadPref, savePref } from '../../lib/planHistory'
import { isForecast, originLabel } from '../../lib/prices'
import {
  exportLane,
  forecastNote,
  forecastRangesOn,
  horizonLane,
  kwhOf,
  loadAsk,
  loadExtras,
  midnightsOn,
  onAxis,
  pvDays,
  priceNote,
  pvNotes,
  sentAxis,
  sentHeads,
  type SentHead,
  SLOT_S,
  slotAt,
  socExtras,
  socNote,
  socNotes,
  socOverlays,
  tariffLane,
  windowBands,
  windowNotes,
} from '../../lib/sent'
import { eurTick, formatAge, formatPower, isNumber, priceFactor, type PriceUnit } from '../../lib/units'
import { Breakable, Tile } from './Tile'

const SYNC = 'sent'
const HOURS_BACK_KEY = 'emhass-lens.inputs.hours-back'
const HOURS_BACK = [0, 24] as const
const AFTER_KEY = 'emhass-lens.inputs.after-horizon'
const AFTER = [0, 1] as const

const POWER_FIT = { minSpan: 500 }
// room above the highest hump for its day's total
const PV_FIT = { minSpan: 500, pad: 0.2, zero: true, clamp: [0, null] as [number, null] }
const PRICE_FIT = { minSpan: 0.01 }
// the charts snap to slots: the arrow keys step one (Shift an hour)
const KEY_STEP = { step: SLOT_S, big: 3600 }
// what was measured before the anchor is fainter, without its fill
const PAST = { line: 0.55, fill: 0 }

const MEASURED: PopupTag = { text: 'measured', tone: 'neutral' }
const NOT_SENT: PopupTag = { text: 'not sent', tone: 'neutral' }

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

const percent = (v: number | null | undefined) => (isNumber(v) ? `${Math.round(v * 100)} %` : '—')
const kwTick = (v: number) => `${(v / 1000).toFixed(Math.abs(v) < 10_000 ? 1 : 0)} kW`
const provider = (origin: string) => originLabel(origin).replace(/^Forecast \((.*)\)$/, '$1')

/** The Inputs page's "What EMHASS gets": the newest MPC payload (or one built now) slot by slot, on one time axis
 *  after what was measured before its anchor, every chart with the Plan page's value popup. */
export function SentPanel({ unit }: { unit: PriceUnit }) {
  const [hoursBack, setHoursBackState] = useState<number>(() => loadPref(HOURS_BACK_KEY, HOURS_BACK, 24))
  const [after, setAfterState] = useState<number>(() => loadPref(AFTER_KEY, AFTER, 1))
  const beyond = after === 1
  const [source, setSource] = useState<'last_run' | 'preview'>('last_run')
  const last = useSentInputs(hoursBack, beyond)
  const preview = useMutation({
    mutationFn: ({ hours, ahead }: { hours: number; ahead: boolean }) =>
      api.post<SentInputs>(`/api/inputs/sent/preview${query({ hours_back: hours, beyond: ahead })}`),
  })
  const data = source === 'preview' ? preview.data : last.data
  const [zoom, setZoom] = useState<[number, number] | null>(null)
  const zoomTo = (range: [number, number] | null) => setZoom(range && snapWindow(range, SLOT_S))

  const setHoursBack = (hours: number) => {
    setHoursBackState(hours)
    savePref(HOURS_BACK_KEY, hours)
    setZoom(null)
    if (source === 'preview') preview.mutate({ hours, ahead: beyond })
  }
  const setAfter = (value: number) => {
    setAfterState(value)
    savePref(AFTER_KEY, value)
    setZoom(null)
    if (source === 'preview') preview.mutate({ hours: hoursBack, ahead: value === 1 })
  }
  const showPreview = () => {
    setSource('preview')
    setZoom(null)
    preview.mutate({ hours: hoursBack, ahead: beyond })
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-title-row">
          <h2>What EMHASS gets</h2>
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
            zoom={zoom}
            zoomTo={zoomTo}
            hoursBack={hoursBack}
            setHoursBack={setHoursBack}
            after={after}
            setAfter={setAfter}
            rebuild={source === 'preview' ? () => preview.mutate({ hours: hoursBack, ahead: beyond }) : undefined}
          />
        )}
      </div>
    </section>
  )
}

function SentView({
  data,
  unit,
  zoom,
  zoomTo,
  hoursBack,
  setHoursBack,
  after,
  setAfter,
  rebuild,
}: {
  data: SentInputs
  unit: PriceUnit
  zoom: [number, number] | null
  zoomTo: (range: [number, number] | null) => void
  hoursBack: number
  setHoursBack: (hours: number) => void
  after: number
  setAfter: (value: number) => void
  rebuild?: () => void
}) {
  const tz = data.timezone
  const charts = useMemo(() => buildCharts(data, unit), [data, unit])
  const { axis } = charts
  // a plan length pointed at: the horizon lane shows where it would end
  const [lengthPreview, setLengthPreview] = useState<HorizonOption | null>(null)
  const priceLanes = useMemo(
    () => [...charts.priceLanes, horizonLane(axis, data, lengthPreview)],
    [charts, axis, data, lengthPreview],
  )
  const shade: [number, number][] = [
    ...(axis.anchorIdx > 0 ? [[axis.x[0] ?? axis.anchorS, axis.anchorS] as [number, number]] : []),
    ...(axis.axisEndS > axis.endS ? [[axis.endS, axis.axisEndS] as [number, number]] : []),
  ]
  // the anchor stands for now: the payload starts there
  const common = {
    x: axis.x,
    syncKey: SYNC,
    timeZone: tz,
    xRange: zoom,
    onZoom: zoomTo,
    shade,
    markers: charts.midnights,
    now: axis.anchorS,
    snapToSlot: true,
    cursorBand: true,
    timeAxis: 'ticks' as const,
    split: { at: axis.anchorS, side: 'before' as const },
  }
  const measuredBy = (q: string) => data.measured_entities[q]
  const heads = useMemo(() => sentHeads(data, { cents: unit === 'cents', hoursBack }), [data, unit, hoursBack])

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
          {zoom && (
            <>
              Zoomed in
              <button type="button" className="quiet" onClick={() => zoomTo(null)}>
                Reset zoom
              </button>
            </>
          )}
        </p>
        <div className="sent-back">
          <PlanLength data={data} onPreview={setLengthPreview} />
          <span className="muted">Before the anchor</span>
          <div className="segmented" role="group" aria-label="Measured before the anchor">
            <button type="button" aria-pressed={hoursBack === 0} onClick={() => setHoursBack(0)}>
              Off
            </button>
            <button type="button" aria-pressed={hoursBack === 24} onClick={() => setHoursBack(24)}>
              24 h measured
            </button>
          </div>
          <span className="muted">After the horizon</span>
          <div className="segmented" role="group" aria-label="Forecast after the horizon">
            <button type="button" aria-pressed={after === 0} onClick={() => setAfter(0)}>
              Off
            </button>
            <button
              type="button"
              aria-pressed={after === 1}
              onClick={() => setAfter(1)}
              title="The price and PV forecast after the plan's end, as they are now; not sent"
            >
              Forecast
            </button>
          </div>
        </div>
      </div>

      <div className="chart-stack">
        <section className="chart-block">
          <SentChartHead head={heads.prices} />
          <TimeChart
            {...common}
            series={charts.prices}
            ariaLabel="Import and export price per quarter-hour: those that applied before the anchor, those sent to EMHASS, and the forecast after the plan's horizon, with the tariff period, the export limit and the horizon under the chart"
            yFormat={(v) => (unit === 'cents' ? `${v.toFixed(0)} c` : eurTick(v))}
            fit={PRICE_FIT}
            keyboard={{ step: KEY_STEP, home: axis.anchorS }}
            hatches={charts.forecastHatches}
            notes={charts.priceNotes}
            height={230}
            lanes={priceLanes}
            popup={charts.pricePopup}
            legend={false}
          />
          <details className="chart-note more">
            <summary>Details</summary>
            <code>load_cost_forecast</code> and <code>prod_price_forecast</code>, fees included and the import price with
            VAT.{charts.forecastHatches.length > 0 && ' Hatched: forecast prices.'}
            {charts.hasPastPrices &&
              hoursBack > 0 &&
              ' Before the anchor: the Nord Pool prices that applied, with today’s tariff (nothing is sent for past slots).'}
            {axis.axisEndS > axis.endS &&
              ' After the horizon (washed, hatched in the Horizon lane): the forecast as it is now, not sent. Plan length picks how many days of it the plan takes after the Nord Pool prices (Settings → Price forecast → Extend by).'}
          </details>
        </section>

        <section className="chart-block">
          <SentChartHead head={heads.pv} />
          <TimeChart
            {...common}
            series={charts.pv}
            ariaLabel="PV measured before the anchor and the Solcast forecast sent to EMHASS after it, per quarter-hour, with each day's total"
            yFormat={kwTick}
            fit={PV_FIT}
            height={210}
            notes={charts.pvNotes}
            popup={charts.sentPopup}
            legend={false}
          />
          {data.pv_slots_missing > 0 && (
            <p className="chart-note">{data.pv_slots_missing} slots had no Solcast value and were sent as 0 W.</p>
          )}
          <details className="chart-note more">
            <summary>Details</summary>
            <code>pv_power_forecast</code> from Solcast. Above each day: its total.
            {charts.hasReserve && ' The EV area is PV held back for the car: EMHASS doesn’t get it.'}
            {measuredBy('pv') && hoursBack > 0 && <> Before the anchor: <code>{measuredBy('pv')}</code>.</>}
            {axis.axisEndS > axis.endS && ' After the horizon: Solcast’s forecast as it is now, not sent.'}
          </details>
        </section>

        <section className="chart-block">
          <SentChartHead head={heads.load} />
          <TimeChart
            {...common}
            series={charts.load}
            ariaLabel="House load measured before the anchor and EMHASS's forecast after it, per quarter-hour, with each deferrable load's window under the chart"
            yFormat={kwTick}
            fit={POWER_FIT}
            height={200}
            hatches={charts.loadWindows}
            notes={charts.loadNotes}
            popup={charts.loadPopup}
            legend={false}
          />
          {data.deferrables.some((d) => !d.on) && (
            <p className="chart-note">
              {data.deferrables
                .filter((d) => !d.on)
                .map((d, i) => (
                  <span key={d.name}>
                    {i > 0 && ' '}
                    {d.name} is off{d.enabled_source && <> (<code>{d.enabled_source}</code>)</>}: sent as 0 W for 0 h.
                  </span>
                ))}
            </p>
          )}
          <details className="chart-note more">
            <summary>Details</summary>
            <LoadNote data={data} />
            {measuredBy('load') && hoursBack > 0 && <> Before the anchor: <code>{measuredBy('load')}</code>.</>}
          </details>
        </section>

        <section className="chart-block">
          <SentChartHead head={heads.soc} />
          <TimeChart
            {...common}
            series={charts.soc}
            ariaLabel="Battery state of charge measured before the anchor, then a line from the state of charge sent at the anchor to the target at the end of the horizon, between the battery's limits"
            yFormat={(v) => `${v.toFixed(0)} %`}
            yRange={[0, 100]}
            height={160}
            overlays={charts.socOverlays}
            notes={charts.socNotes}
            popup={charts.socPopup}
            timeAxis="labels"
            nowLabel={`anchor ${cursorTimeLabel(axis.anchorS, tz, false)}`}
            legend={false}
          />
          <details className="chart-note more">
            <summary>Details</summary>
            <code>soc_init</code>
            {data.soc_init_reading && <> from <code>{data.soc_init_reading.source}</code>{ageOf(data.soc_init_reading.age_s)}</>}, and{' '}
            <code>soc_final</code>, the target at the end of the horizon
            {data.soc_final_reading && <>, from <code>{data.soc_final_reading.source}</code></>}. EMHASS plans the path between them.
            {measuredBy('soc') && hoursBack > 0 && <> Before the anchor: <code>{measuredBy('soc')}</code>.</>}
          </details>
        </section>
      </div>
      <p className="chart-note">
        Point at a chart to read its inputs at that quarter-hour; every chart shows the same slot. On the prices chart,{' '}
        {keyHint(KEY_STEP).replace(/^A/, 'a')}; Home goes back to the anchor. Prices include fees and VAT.
        {isNumber(data.no_export_at_or_below) && (
          <>
            {' '}
            Export is capped at 0 W wherever the export price is at or below {data.no_export_at_or_below} €/kWh (
            <code>maximum_power_to_grid</code>).
          </>
        )}
      </p>
    </>
  )
}

/** A chart's head: its title, unit and key, with the payload keys it comes from at the right. */
function SentChartHead({ head }: { head: SentHead }) {
  return (
    <ChartHead
      title={head.title}
      unit={head.unit}
      keys={head.keys}
      summary={
        <span className="chart-params">
          {head.params.map((p) => (
            <code key={p}>
              <Breakable text={p} />
            </code>
          ))}
        </span>
      }
    />
  )
}

const daysText = (days: number) => `${days} day${days === 1 ? '' : 's'}`

/** "Plan length": how many days of price forecast the plan takes after the Nord Pool prices (Settings → Price
 *  forecast → Extend by). Pointing at a choice shows in the Horizon lane where that plan would end with today's data;
 *  picking one asks first, then saves it for the next MPC run. */
function PlanLength({ data, onPreview }: { data: SentInputs; onPreview: (option: HorizonOption | null) => void }) {
  const writable = useStatus().data?.writable ?? false
  const fitOnFault = useSettings().data?.settings.emhass.ml.fit_on_fault ?? false
  const setDays = useSetExtendDays()
  const [chosen, setChosen] = useState<HorizonOption | null>(null)
  const options = data.horizon_options ?? []
  const tz = data.timezone
  if (options.length === 0) {
    return (
      <Link className="muted" to="/settings?section=forecast" title="Without a price forecast the plan ends with the Nord Pool prices">
        No price forecast
      </Link>
    )
  }
  const current = options.find((o) => o.days === data.extend_days)
  const until = (o: HorizonOption) => `until ${dayTime(Date.parse(o.end) / 1000, tz)}, ${o.slots} slots (${o.slots / 4} h)`
  const close = () => {
    setChosen(null)
    setDays.reset()
  }
  return (
    <>
      <span className="muted">Plan length</span>
      <div className="segmented" role="group" aria-label="Days of price forecast after the Nord Pool prices">
        {options.map((o, i) => {
          // the forecast ran out: more days plan no further
          const same = i > 0 && o.short && options[i - 1]?.end === o.end
          return (
            <button
              key={o.days}
              type="button"
              aria-pressed={o.days === data.extend_days}
              disabled={!writable || same || setDays.isPending}
              title={
                same
                  ? `The price forecast ends ${dayTime(Date.parse(o.end) / 1000, tz)}: ${daysText(o.days)} plan no further`
                  : `Nord Pool + ${daysText(o.days)} of forecast: ${until(o)}`
              }
              onMouseEnter={() => onPreview(o)}
              onMouseLeave={() => onPreview(null)}
              onFocus={() => onPreview(o)}
              onBlur={() => onPreview(null)}
              onClick={() => o.days !== data.extend_days && setChosen(o)}
            >
              {o.days} d
            </button>
          )
        })}
      </div>
      <ConfirmDialog
        open={chosen !== null}
        title={`Plan with ${daysText(chosen?.days ?? 0)} of price forecast?`}
        onClose={close}
        actions={[
          {
            label: setDays.isPending ? 'Saving…' : `Use ${daysText(chosen?.days ?? 0)}`,
            kind: 'primary',
            onClick: () => chosen && setDays.mutate(chosen.days, { onSuccess: close }),
            disabled: setDays.isPending,
          },
        ]}
      >
        {chosen && (
          <p>
            From the next MPC run the plan takes the Nord Pool prices and {daysText(chosen.days)} of the price forecast
            after them: with today&rsquo;s data {until(chosen)}
            {chosen.short ? ', where the forecast ends' : ''}. Preview now shows it right away.
          </p>
        )}
        {chosen && current && chosen.num_lags !== current.num_lags && (
          <p>
            EMHASS&rsquo;s load model then uses {chosen.num_lags} lags instead of {current.num_lags}.{' '}
            {fitOnFault
              ? 'EMHASS Lens fits it again after the next MPC run.'
              : 'Fit it again under Health → ML load forecast.'}
          </p>
        )}
        <p className="cell-sub">
          The change is stored as a settings revision and can be reverted from Settings → History.
        </p>
        {setDays.error && (
          <div className="notice" data-color="red">
            {(setDays.error as Error).message}
          </div>
        )}
      </ConfirmDialog>
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
  const loads = data.deferrables
  const one = loads.length === 1 ? loads[0] : undefined
  const m = data.model
  return (
    <div className="cards sent-cards">
      <Tile
        title="Horizon"
        color="--ink-faint"
        value={`${slots.length} slots`}
        sub={`${(slots.length / 4).toFixed(slots.length % 4 ? 2 : 0)} h, ${dayTime(anchorS, tz)} → ${dayTime(endS, tz)}`}
        keys={['prediction_horizon']}
      />
      <Tile
        title="Prices"
        color="--q-import"
        value={forecastSlot ? `${actual} + ${slots.length - actual}` : `${actual}`}
        sub={
          forecastSlot && forecastFrom !== null
            ? `Nord Pool to ${dayTime(forecastFrom, tz)}, then ${provider(forecastSlot.origin)}`
            : 'All from Nord Pool'
        }
        keys={['load_cost_forecast', 'prod_price_forecast']}
      />
      <Tile
        title="PV forecast"
        color="--q-pv"
        value={`${pvKwh.toFixed(1)} kWh`}
        sub={
          <>
            Solcast, {data.pv_sensors} day sensors
            {data.pv_slots_missing > 0 && ` · ${data.pv_slots_missing} slots missing`}
          </>
        }
        keys={['pv_power_forecast']}
      />
      <Tile
        title="Battery"
        color="--q-soc"
        value={`${percent(data.soc_init)} → ${percent(data.soc_final)}`}
        sub="now → the target at the end of the horizon"
        keys={['soc_init', 'soc_final']}
      />
      {data.load_source === 'sent' ? (
        <Tile
          title="House load"
          color="--q-load"
          value="Sent"
          sub="From the extra runtime parameters"
          keys={['load_power_forecast']}
        />
      ) : (
        <Tile
          title="House load"
          color="--q-load"
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
      <Tile
        title="Deferrable loads"
        color="--q-ev"
        value={loads.length === 0 ? 'None' : one ? `${one.name} ${one.on ? 'on' : 'off'}` : `${loads.filter((d) => d.on).length} of ${loads.length} on`}
        sub={
          loads.length === 0
            ? 'None set up'
            : one
              ? one.on
                ? `${loadAsk(one)}${windowText(one, anchorS, endS, tz)}`
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

/** ", window Sat 01:00–07:00" from the load's first allowed timestep, ", by Sat 07:00" from the anchor, or nothing. */
function windowText(load: SentInputs['deferrables'][number], anchorS: number, endS: number, tz: string): string {
  const start = Math.max(0, load.start_timesteps ?? 0)
  const end = load.end_timesteps > 0 ? Math.min(endS, anchorS + load.end_timesteps * SLOT_S) : null
  if (start > 0) return `, window ${dayTime(anchorS + start * SLOT_S, tz)}–${end ? dayTime(end, tz).slice(-5) : 'the end'}`
  return end ? ` by ${dayTime(end, tz)}` : ''
}

function buildCharts(data: SentInputs, unit: PriceUnit) {
  const axis = sentAxis(data)
  const tz = data.timezone
  const slots = data.slots
  const f = priceFactor(unit)
  const priceFormat = unit === 'cents' ? (v: number) => `${v.toFixed(1)} c/kWh` : (v: number) => `${v.toFixed(3)} €/kWh`
  const beyond = data.beyond ?? []
  const sentTag = (text: string) => (t: number): PopupTag =>
    t < axis.anchorS ? MEASURED : t >= axis.endS ? NOT_SENT : { text, tone: 'blue' }

  // before the anchor: the prices that applied (nothing is sent for past slots)
  const scaled = (v: number | null | undefined) => (isNumber(v) ? v * f : null)
  // after the horizon: the forecast as it is now, not sent
  const importValues = onAxis(
    axis,
    data.measured.map((m) => scaled(m.load_cost)),
    slots.map((s) => s.load_cost * f),
    beyond.map((b) => b.load_cost * f),
  )
  const exportValues = onAxis(
    axis,
    data.measured.map((m) => scaled(m.prod_price)),
    slots.map((s) => s.prod_price * f),
    beyond.map((b) => b.prod_price * f),
  )
  const prices: ChartSeries[] = [
    { label: 'Import', color: '--q-import', values: closeSteps(importValues), readout: importValues, format: priceFormat, fade: PAST },
    { label: 'Export', color: '--q-export', values: closeSteps(exportValues), readout: exportValues, format: priceFormat, fade: PAST },
  ]
  const exportRow = exportLane(axis, data)
  const pricePopup = {
    tag: (t: number): PopupTag | null => {
      const i = slotAt(axis, t)
      if (i < 0) return isNumber(data.measured[axis.anchorIdx + i]?.load_cost) ? { text: originLabel('actual'), tone: 'neutral' } : null
      const after = beyond[i - slots.length]
      if (after) return { text: `Not sent · ${originLabel(after.origin)}`, tone: 'neutral' }
      const slot = slots[i]
      return slot ? { text: originLabel(slot.origin), tone: isForecast(slot.origin) ? 'blue' : 'neutral' } : null
    },
    note: (t: number) => priceNote(axis, data, t),
  }

  const pvValues = onAxis(
    axis,
    data.measured.map((m) => m.pv),
    slots.map((s) => s.pv_w),
    beyond.map((b) => b.pv_w),
  )
  const hasReserve = slots.some((s) => (s.ev_reserved_w ?? 0) > 0)
  const pv: ChartSeries[] = [
    { label: 'PV', color: '--q-pv', fill: 0.16, values: closeSteps(pvValues), readout: pvValues, format: formatPower, fade: PAST },
  ]
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
    {
      label: 'House load',
      color: '--q-load',
      fill: 0.16,
      values: closeSteps(loadValues),
      readout: loadValues,
      format: formatPower,
      fade: PAST,
    },
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
  return {
    axis,
    midnights: midnightsOn(axis, tz),
    forecastHatches: forecastRangesOn(axis, data).map(([from, to]) => ({ from, to })),
    priceNotes: [forecastNote(axis, data, tz)].filter((n): n is ChartNote => n !== null),
    prices,
    hasPastPrices: data.measured.some((m) => isNumber(m.load_cost)),
    priceLanes: exportRow ? [tariffLane(axis, data), exportRow] : [tariffLane(axis, data)],
    pricePopup,
    pv,
    hasReserve,
    pvNotes: pvNotes(pvDays(axis, pvValues, tz)),
    sentPopup: { tag: sentTag('sent') },
    load,
    loadWindows: windowBands(axis, data.deferrables),
    loadNotes: windowNotes(axis, data.deferrables, tz),
    loadPopup: { tag: sentTag(loadTag), extra: (t: number) => loadExtras(axis, data.deferrables, t) },
    soc,
    socOverlays: socOverlays(axis, data),
    socNotes: socNotes(axis, data),
    socPopup: {
      tag: sentTag('sent'),
      extra: (t: number) => socExtras(axis, data, t),
      note: (t: number) => (t >= axis.anchorS ? socNote(data) : null),
    },
  }
}
