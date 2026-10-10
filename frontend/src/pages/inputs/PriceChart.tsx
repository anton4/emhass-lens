import { useMemo } from 'react'
import type { PricesResponse } from '../../api/types'
import { TimeChart, type ChartSeries } from '../../components/charts/TimeChart'
import { forecastRanges, midnights } from '../../lib/prices'
import { priceFactor, type PriceUnit } from '../../lib/units'

/** Import, export and spot price per quarter-hour; forecast shaded, midnights and now marked. */
export function PriceChart({ data, unit, nowS }: { data: PricesResponse; unit: PriceUnit; nowS: number }) {
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
    const digits = unit === 'cents' ? 2 : 4
    const suffix = unit === 'cents' ? 'c/kWh' : '€/kWh'
    const fmt = (v: number) => `${v.toFixed(digits)} ${suffix}`
    const series: ChartSeries[] = [
      { label: 'Import', color: '--series-1', values: cols[0] ?? [], format: fmt },
      { label: 'Export', color: '--series-2', values: cols[1] ?? [], format: fmt },
      { label: 'Spot', color: '--series-3', values: cols[2] ?? [], width: 1.5, format: fmt },
    ]
    return { x, series, bands: forecastRanges(slots), markers: midnights(slots, data.timezone) }
  }, [data, unit])

  return (
    <TimeChart
      x={chart.x}
      series={chart.series}
      ariaLabel="Import, export and spot price per quarter-hour. The breakdown table below has every value."
      timeZone={data.timezone}
      yFormat={(v) => (unit === 'cents' ? `${v.toFixed(0)} c` : v.toFixed(2))}
      bands={chart.bands}
      markers={chart.markers}
      now={nowS}
      height={260}
      legendValueWidth="13ch"
    />
  )
}
