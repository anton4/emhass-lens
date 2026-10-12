import { useEffect, useMemo, useState } from 'react'
import type { PriceSlot } from '../../api/types'
import { TimeChart, type ChartSeries } from '../../components/charts/TimeChart'
import { forecastRanges, importComponents, midnights, periodLabel, PRICE_PARTS, stackLayers, type PricePart } from '../../lib/prices'
import { eurTick, priceFactor, type PriceUnit } from '../../lib/units'

// Spot in its own grey (as on every chart); what is added on top of it in the import price's violets, light to deep,
// so neighbours always differ in lightness.
const PARTS: readonly { key: PricePart; label: string; color: string }[] = [
  { key: 'spot', label: 'Spot', color: '--q-spot' },
  { key: 'fees', label: 'Fees (margin, renewable, excise, balancing, supply security)', color: '--stack-fees' },
  { key: 'network', label: 'Network', color: '--stack-network' },
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

/** What each quarter-hour's import price is made of: spot, fees, network and VAT stacked on the price chart's time
 *  axis, with the import price on top; the cursor, the zoom and the popup go along with the price chart. */
export function PriceStack({
  slots,
  unit,
  timeZone,
  nowS,
  syncKey,
  xRange,
  onZoom,
}: {
  slots: PriceSlot[]
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
      popupLabel: key === 'fees' ? 'Fees' : undefined,
      color: PARTS.find((p) => p.key === key)!.color,
      values: closed(layers[key].hi, f),
      readout: closed(
        parts.map((p) => p[key]),
        f,
      ),
      below,
      fill: below === undefined ? 1 : undefined,
      width: shown.has(key) ? 1 : 0,
      muted: !shown.has(key),
      format: fmt,
    })
    const all = PRICE_PARTS.every((p) => shown.has(p))
    const series: ChartSeries[] = [
      part('spot', undefined),
      // the edge the other parts stack from: the top of a positive spot, zero under a negative one
      { label: 'Stack base', color: '--q-spot', values: closed(layers.fees.lo, f), helper: true },
      part('fees', 1),
      part('network', 2),
      part('vat', 3),
      {
        label: 'Import',
        color: '--q-import',
        values: closed(
          parts.map((p) => p.total),
          f,
        ),
        width: all ? 2 : 0,
        total: true,
        format: fmt,
      },
    ]
    const periods = new Map(slots.map((s) => [Date.parse(s.start) / 1000, s.period]))
    const tag = (t: number) => {
      const period = periods.get(t)
      return period ? { text: `${periodLabel(period)} rate` } : null
    }
    return { x, series, tag, bands: forecastRanges(slots), markers: midnights(slots, timeZone), minSpan: 0.01 * f }
  }, [slots, unit, shown, timeZone])

  return (
    <div className="price-stack">
      <TimeChart
        x={chart.x}
        series={chart.series}
        ariaLabel="What each quarter-hour's import price is made of: spot, fees, network and VAT, stacked. The table below has every value."
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
      />
      <ul className="legend" role="group" aria-label="Parts shown in the chart">
        {PARTS.map((p) => (
          <li key={p.key}>
            <button
              type="button"
              className="legend-toggle"
              aria-pressed={shown.has(p.key)}
              title={shown.has(p.key) ? 'Hide from the chart' : 'Show in the chart'}
              onClick={() => toggle(p.key)}
            >
              <span className="legend-swatch" style={{ background: `var(${p.color})`, color: `var(${p.color})` }} />
              {p.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
