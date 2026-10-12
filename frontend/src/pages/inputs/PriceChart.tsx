import { useMemo } from 'react'
import type { PricesResponse } from '../../api/types'
import { TimeChart, type ChartSeries } from '../../components/charts/TimeChart'
import { forecastRanges, isForecast, midnights, originLabel } from '../../lib/prices'
import { eurTick, priceFactor, type PriceUnit } from '../../lib/units'

/** Import, export and spot price per quarter-hour; forecast shaded, midnights and now marked. Its cursor, zoom and
 *  popup go along with the breakdown under it (`syncKey`). */
export function PriceChart({
  data,
  unit,
  nowS,
  syncKey,
  xRange,
  onZoom,
}: {
  data: PricesResponse
  unit: PriceUnit
  nowS: number
  syncKey: string
  xRange: [number, number] | null
  onZoom: (range: [number, number] | null) => void
}) {
  const chart = useMemo(() => {
    const f = priceFactor(unit)
    const slots = data.slots
    const x = slots.map((s) => Date.parse(s.start) / 1000)
    const cols: (number | null)[][] = [
      slots.map((s) => s.import_price * f),
      slots.map((s) => s.export_price * f),
      slots.map((s) => s.spot * f),
    ]
    const last = slots[slots.length - 1]
    if (last) {
      x.push(Date.parse(last.end) / 1000)
      for (const c of cols) c.push(c[c.length - 1] ?? null)
    }
    const fmt = unit === 'cents' ? (v: number) => `${v.toFixed(1)} c/kWh` : (v: number) => `${v.toFixed(3)} €/kWh`
    const series: ChartSeries[] = [
      { label: 'Import', color: '--q-import', values: cols[0] ?? [], format: fmt },
      { label: 'Export', color: '--q-export', values: cols[1] ?? [], format: fmt },
      { label: 'Spot', color: '--q-spot', dash: [4, 4], values: cols[2] ?? [], width: 1.5, format: fmt },
    ]
    const origins = new Map(slots.map((s) => [Date.parse(s.start) / 1000, s.origin]))
    const tag = (t: number) => {
      const origin = origins.get(t)
      return origin ? { text: originLabel(origin), tone: isForecast(origin) ? ('blue' as const) : ('neutral' as const) } : null
    }
    return { x, series, tag, bands: forecastRanges(slots), markers: midnights(slots, data.timezone) }
  }, [data, unit])

  return (
    <TimeChart
      x={chart.x}
      series={chart.series}
      ariaLabel="Import, export and spot price per quarter-hour. The breakdown table below has every value."
      syncKey={syncKey}
      timeZone={data.timezone}
      yFormat={(v) => (unit === 'cents' ? `${v.toFixed(0)} c` : eurTick(v))}
      xRange={xRange}
      onZoom={onZoom}
      bands={chart.bands}
      markers={chart.markers}
      now={nowS}
      height={260}
      popup={{ tag: chart.tag }}
    />
  )
}
