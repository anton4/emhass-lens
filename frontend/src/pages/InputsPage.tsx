import { useMemo, useState } from 'react'
import { useInputs, usePrices } from '../api/queries'
import type { ForecastStatus, HaStatus, InputsSnapshot, NordpoolStatus } from '../api/types'
import { LabelledLamp, Lamp } from '../components/Lamp'
import { Empty, ErrorNotice, PageHead } from '../components/PageHead'
import { InputsView } from '../components/Readings'
import { useNow } from '../components/useNow'
import { formatCountdown, formatTime } from '../lib/format'
import { localDay, localDays, slotsOfDay } from '../lib/prices'
import type { PriceUnit } from '../lib/units'
import { Breakdown } from './inputs/Breakdown'
import { MpcPreviewPanel } from './inputs/MpcPreviewPanel'
import { PriceChart } from './inputs/PriceChart'
import { PriceStack } from './inputs/PriceStack'

const PROVIDERS: Record<string, string> = {
  ee_eupowerprices: 'eupowerprices.com (EE)',
  fi_ha_entity: 'nordpool-predict-fi (FI)',
}

const dayLabel = (day: string) =>
  new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${day}T12:00:00`))

export function InputsPage() {
  const prices = usePrices(1)
  const inputs = useInputs()
  const now = useNow(30_000)
  const nowS = now.getTime() / 1000
  const [unit, setUnit] = useState<PriceUnit>('cents')
  const data = prices.data
  const tz = data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const days = useMemo(() => (data ? localDays(data.slots, tz) : []), [data, tz])
  const today = localDay(now.toISOString(), tz)
  const [chosen, setChosen] = useState<string | null>(null)
  const day = chosen && days.includes(chosen) ? chosen : days.includes(today) ? today : (days[0] ?? null)
  const daySlots = useMemo(() => (data && day ? slotsOfDay(data.slots, day, tz) : []), [data, day, tz])
  const nordpool = data?.nordpool as unknown as NordpoolStatus | undefined
  const forecast = data?.forecast as unknown as ForecastStatus | undefined

  return (
    <>
      <PageHead title="Inputs" intro="Everything EMHASS is fed, each value with where it came from and how old it is.">
        <div className="segmented" role="group" aria-label="Price unit">
          <button type="button" aria-pressed={unit === 'cents'} onClick={() => setUnit('cents')}>
            c/kWh
          </button>
          <button type="button" aria-pressed={unit === 'eur'} onClick={() => setUnit('eur')}>
            €/kWh
          </button>
        </div>
      </PageHead>
      <ErrorNotice error={prices.error ?? inputs.error} />

      <section className="panel">
        <div className="panel-head">
          <h2>Prices</h2>
          {data && (
            <span className="muted">
              {data.package === 'custom' ? 'Custom network rates' : data.package.replace('vork', 'Võrk ')} · times in {tz}
            </span>
          )}
        </div>
        <div className="panel-body">
          {data && data.slots.length > 0 ? (
            <>
              <PriceChart data={data} unit={unit} nowS={nowS} />
              {data.forecast_until && <p className="chart-note">Shaded: forecast prices until {formatTime(data.forecast_until, now)}.</p>}
              {data.gaps.length > 0 && (
                <div className="notice" data-color="amber">
                  Gaps in the published prices: {data.gaps.map(([a, b]) => `${formatTime(a, now)} → ${formatTime(b, now)}`).join(', ')}
                </div>
              )}
            </>
          ) : (
            prices.isSuccess && <Empty title="No prices yet">The Nord Pool job fetches them; see its status below.</Empty>
          )}
        </div>
      </section>

      <div className="two-col">
        <section className="panel">
          <div className="panel-head">
            <h2>Nord Pool</h2>
            {nordpool && <span className="muted">{nordpool.area}, by delivery day (CET)</span>}
          </div>
          <div className="panel-body">
            <div className="chips">
              {(nordpool?.days ?? []).map((d) => (
                <span
                  key={d.day}
                  className="chip"
                  data-color={d.error ? 'red' : d.state === 'Final' ? 'green' : d.slots > 0 ? 'amber' : undefined}
                  title={d.error ?? undefined}
                >
                  <Lamp color={d.error ? 'red' : d.state === 'Final' ? 'green' : d.slots > 0 ? 'amber' : 'neutral'} />
                  {d.day}: {d.slots > 0 ? `${d.state} · ${d.slots}` : d.not_published ? 'not published' : d.error ? `error ${d.http_status ?? ''}` : 'not fetched'}
                </span>
              ))}
            </div>
            <h3 className="sub-head">Next fetches</h3>
            {(nordpool?.next ?? []).length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                Nothing due: every day needed is Final.
              </p>
            ) : (
              <ul className="plain-list">
                {nordpool?.next.map((n) => (
                  <li key={n.day}>
                    <span className="num">{n.day}</span> <span className="countdown">{formatCountdown(n.due_at, now)}</span>
                    <div className="cell-sub">{n.reason}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Price forecast</h2>
            {forecast && <span className="muted">{forecast.source === 'none' ? 'off' : PROVIDERS[forecast.source] ?? forecast.source}</span>}
          </div>
          <div className="panel-body">
            {forecast &&
              Object.entries(forecast.providers).map(([name, st]) => {
                const active = forecast.source === name
                return (
                  <div key={name} className="provider">
                    <LabelledLamp
                      color={!active ? 'neutral' : st.error ? 'red' : st.points > 0 ? 'green' : 'amber'}
                      text={`${PROVIDERS[name] ?? name}${active ? '' : ' (not selected)'}`}
                    />
                    <div className="cell-sub">
                      {st.points > 0 ? `${st.points} points, ${formatTime(st.start, now)} → ${formatTime(st.end, now)}` : 'No data'}
                      {st.last_success && ` · updated ${formatTime(st.last_success, now)}`}
                    </div>
                    {st.error && active && <div className="field-error">{st.error}</div>}
                  </div>
                )
              })}
          </div>
        </section>
      </div>

      {data && day && (
        <section className="panel">
          <div className="panel-head">
            <h2>Price breakdown</h2>
            <div className="segmented" role="group" aria-label="Day">
              {days.map((d) => (
                <button key={d} type="button" aria-pressed={d === day} onClick={() => setChosen(d)}>
                  {d === today ? 'Today' : dayLabel(d)}
                </button>
              ))}
            </div>
          </div>
          <div className="panel-body">
            <PriceStack slots={daySlots} unit={unit} timeZone={tz} nowS={nowS} />
            <Breakdown slots={daySlots} unit={unit} timeZone={tz} nowS={nowS} />
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>Values from Home Assistant</h2>
          {inputs.data && <HaLamp ha={inputs.data.home_assistant as unknown as HaStatus} />}
        </div>
        <div className="panel-body">
          {inputs.data ? (
            <InputsView snapshot={inputs.data.snapshot as unknown as InputsSnapshot} />
          ) : (
            <span className="muted">Loading…</span>
          )}
        </div>
      </section>

      <MpcPreviewPanel />
    </>
  )
}

function HaLamp({ ha }: { ha: HaStatus }) {
  if (!ha.configured) return <LabelledLamp color="red" text="No Home Assistant access" />
  if (ha.connected) return <LabelledLamp color="green" text={`Home Assistant ${ha.ha_version ?? ''}, ${ha.watched} entities watched`} />
  return <LabelledLamp color="red" text={`Not connected${ha.last_error ? `: ${ha.last_error}` : ''}`} />
}
