import { useEffect, useMemo, useState } from 'react'
import type { PriceSlot, PricesResponse } from '../../api/types'
import { ChartHead } from '../../components/charts/ChartHead'
import { TimeChart, type ChartNote, type ChartSeries } from '../../components/charts/TimeChart'
import { cursorTimeLabel, dayTimeLabel } from '../../lib/chartTime'
import { priceSummary, slotsIn, tariffNote, windowTitle } from '../../lib/priceBreakdown'
import {
  forecastRanges,
  importComponents,
  midnights,
  periodLabel,
  PRICE_PARTS,
  priceExtremes,
  stackLayers,
  type PricePart,
} from '../../lib/prices'
import { eurTick, priceFactor, type PriceUnit } from '../../lib/units'
import { Tile } from './Tile'

// Bottom to top in four hues whose neighbours pass the colour-vision check in both themes (tokens.css --stack-*).
const PARTS: readonly { key: PricePart; label: string; color: string; title?: string }[] = [
  { key: 'spot', label: 'Spot', color: '--stack-spot' },
  { key: 'network', label: 'Network', color: '--stack-network' },
  { key: 'fees', label: 'Fees', color: '--stack-fees', title: 'Margin, renewable, excise, balancing and supply security' },
  { key: 'vat', label: 'VAT', color: '--stack-vat' },
]

// The parts shown are remembered in this browser only; blocked storage just means all four.
const STORAGE_KEY = 'emhass-lens.price-breakdown.parts'

function loadShown(): Set<PricePart> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (Array.isArray(saved)) return new Set(PRICE_PARTS.filter((p) => saved.includes(p)))
  } catch {
    // fall through to the default
  }
  return new Set(PRICE_PARTS)
}

function saveShown(shown: Set<PricePart>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...shown]))
  } catch {
    // not remembered, still works for this visit
  }
}

/** A step series on the price chart's grid: one value per slot and the last one again at the closing point. */
function closed(values: number[], factor: number): (number | null)[] {
  const out: (number | null)[] = values.map((v) => v * factor)
  out.push(out[out.length - 1] ?? null)
  return out
}

/** What each quarter-hour's import price is made of: tiles over the slots in view (the average, how much of it is
 *  spot, the cheapest and the dearest), then a column per slot of spot, network, fees and VAT stacked, on the price
 *  chart's time axis, with the import price as a cap and each day's cheapest and dearest quarter-hour named, and the
 *  tariff's parts under it; the cursor, the zoom and the popup go along with the price chart. */
export function PriceStack({
  slots,
  tariff,
  unit,
  timeZone,
  nowS,
  syncKey,
  xRange,
  onZoom,
}: {
  slots: PriceSlot[]
  tariff?: PricesResponse['tariff']
  unit: PriceUnit
  timeZone: string
  nowS: number
  syncKey: string
  xRange: [number, number] | null
  onZoom: (range: [number, number] | null) => void
}) {
  const [shown, setShown] = useState<Set<PricePart>>(loadShown)
  useEffect(() => saveShown(shown), [shown])
  const toggle = (key: PricePart) =>
    setShown((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const chart = useMemo(() => {
    const f = priceFactor(unit)
    const fmt = unit === 'cents' ? (v: number) => `${v.toFixed(1)} c/kWh` : (v: number) => `${v.toFixed(3)} €/kWh`
    const x = slots.map((s) => Date.parse(s.start) / 1000)
    const last = slots[slots.length - 1]
    if (last) x.push(Date.parse(last.end) / 1000)
    const parts = slots.map(importComponents)
    const layers = stackLayers(parts, shown)
    const part = (key: PricePart, below: number | undefined): ChartSeries => ({
      label: PARTS.find((p) => p.key === key)!.label,
      color: PARTS.find((p) => p.key === key)!.color,
      values: closed(layers[key].hi, f),
      readout: closed(
        parts.map((p) => p[key]),
        f,
      ),
      below,
      column: 'stack',
      muted: !shown.has(key),
      format: fmt,
    })
    const all = PRICE_PARTS.every((p) => shown.has(p))
    const series: ChartSeries[] = [
      part('spot', undefined),
      // the edge the other parts stack from: the top of a positive spot, zero under a negative one
      { label: 'Stack base', color: '--stack-spot', values: closed(layers.network.lo, f), helper: true },
      part('network', 1),
      part('fees', 2),
      part('vat', 3),
      {
        label: 'Import',
        color: '--q-import',
        values: closed(
          parts.map((p) => p.total),
          f,
        ),
        width: all ? 2 : 0,
        column: 'cap',
        total: true,
        format: fmt,
      },
    ]
    const periods = new Map(slots.map((s) => [Date.parse(s.start) / 1000, s.period]))
    const tag = (t: number) => {
      const period = periods.get(t)
      return period ? { text: `${periodLabel(period)} rate` } : null
    }
    // each day's cheapest and dearest quarter-hour, named over its column
    const at = (v: number) => (unit === 'cents' ? `${(v * f).toFixed(1)} c` : (v * f).toFixed(3))
    const notes: ChartNote[] = priceExtremes(slots, timeZone).flatMap((d) => [
      { t: d.cheapest.t + 450, value: d.cheapest.value * f, text: `cheapest ${at(d.cheapest.value)}`, color: '--ink-2' },
      { t: d.dearest.t + 450, value: d.dearest.value * f, text: `dearest ${at(d.dearest.value)}`, color: '--ink-2' },
    ])
    return { x, series, tag, notes, bands: forecastRanges(slots), markers: midnights(slots, timeZone), minSpan: 0.01 * f }
  }, [slots, unit, shown, timeZone])

  const first = slots[0]
  const last = slots[slots.length - 1]
  const window: [number, number] | null =
    xRange ?? (first && last ? [Date.parse(first.start) / 1000, Date.parse(last.end) / 1000] : null)
  const summary = useMemo(() => priceSummary(slotsIn(slots, xRange), tariff?.vat_pct), [slots, xRange, tariff])
  const f = priceFactor(unit)
  const price = (v: number) => (unit === 'cents' ? `${(v * f).toFixed(1)} c/kWh` : `${v.toFixed(3)} €/kWh`)
  const slotName = (s: PriceSlot) =>
    `${dayTimeLabel(Date.parse(s.start) / 1000, timeZone)}–${cursorTimeLabel(Date.parse(s.end) / 1000, timeZone, false)}`

  return (
    <div className="price-stack">
      {summary && (
        <div className="cards price-cards">
          <Tile
            title="Average import price"
            color="--q-import"
            value={price(summary.average)}
            sub={`over the ${summary.slots} quarter-hour${summary.slots === 1 ? '' : 's'} shown`}
          />
          <Tile
            title="Spot share, with its VAT"
            color="--stack-spot"
            value={summary.spotShare === null ? '—' : `${Math.round(summary.spotShare * 100)} %`}
            sub="the rest is network, fees and their VAT"
          />
          <Tile title="Cheapest" value={price(summary.cheapest.import_price)} sub={slotName(summary.cheapest)} />
          <Tile title="Dearest" value={price(summary.dearest.import_price)} sub={slotName(summary.dearest)} />
        </div>
      )}
      <ChartHead
        title={window ? windowTitle(window, nowS, timeZone) : 'What the import price is made of'}
        unit={`${unit === 'cents' ? 'c/kWh' : '€/kWh'}, VAT included`}
      >
        <ul className="legend" role="group" aria-label="Parts shown in the chart">
          {PARTS.map((p) => (
            <li key={p.key}>
              <button
                type="button"
                className="legend-toggle"
                aria-pressed={shown.has(p.key)}
                title={`${p.title ? `${p.title}. ` : ''}${shown.has(p.key) ? 'Hide from the chart' : 'Show in the chart'}`}
                onClick={() => toggle(p.key)}
              >
                <span className="legend-swatch" style={{ background: `var(${p.color})`, color: `var(${p.color})` }} />
                {p.label}
              </button>
            </li>
          ))}
        </ul>
      </ChartHead>
      <TimeChart
        x={chart.x}
        series={chart.series}
        ariaLabel="What each quarter-hour's import price is made of: a column of spot, network, fees and VAT, stacked, with each day's cheapest and dearest quarter-hour named. The table below has every value."
        syncKey={syncKey}
        timeZone={timeZone}
        yFormat={(v) => (unit === 'cents' ? `${v.toFixed(0)} c` : eurTick(v))}
        fit={{ minSpan: chart.minSpan, zero: true }}
        xRange={xRange}
        onZoom={onZoom}
        bands={chart.bands}
        markers={chart.markers}
        now={nowS}
        height={240}
        popup={{ tag: chart.tag }}
        legend={false}
        notes={chart.notes}
        snapToSlot
      />
      {tariff && <p className="chart-note">{tariffNote(tariff, unit === 'cents')}</p>}
    </div>
  )
}
