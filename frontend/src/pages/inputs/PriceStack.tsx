import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PriceSlot } from '../../api/types'
import { importComponents, localTime, periodLabel } from '../../lib/prices'
import { formatPrice, priceFactor, type PriceUnit } from '../../lib/units'

const PARTS = [
  { key: 'spot', label: 'Spot', color: 'var(--series-1)' },
  { key: 'fees', label: 'Fees (margin, renewable, excise, balancing, supply security)', color: 'var(--series-2)' },
  { key: 'network', label: 'Network', color: 'var(--series-3)' },
  { key: 'vat', label: 'VAT', color: 'var(--series-4)' },
] as const

const PAD = { top: 10, right: 8, bottom: 22, left: 52 }

/** 1, 2 or 5 × a power of ten, at least `rough`. */
function niceStep(rough: number): number {
  const power = 10 ** Math.floor(Math.log10(Math.max(rough, 1e-9)))
  for (const m of [1, 2, 5, 10]) if (m * power >= rough) return m * power
  return 10 * power
}

function niceTicks(min: number, max: number, count: number): number[] {
  const step = niceStep((max - min) / count)
  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step / 1e6; v += step) out.push(Number(v.toFixed(10)))
  return out
}
const HEIGHT = 220

/** What each quarter-hour's import price is made of: spot, fees, network and VAT, stacked. */
export function PriceStack({ slots, unit, timeZone, nowS }: { slots: PriceSlot[]; unit: PriceUnit; timeZone: string; nowS: number }) {
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  const [hover, setHover] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    setWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [])

  const f = priceFactor(unit)
  const parts = useMemo(() => slots.map(importComponents), [slots])
  const rawMax = Math.max(0.0001, ...parts.map((p) => Math.max(p.total, p.fees + p.network + p.vat + Math.max(p.spot, 0))))
  const rawMin = Math.min(0, ...parts.map((p) => p.spot))
  const step = niceStep((rawMax - rawMin) / 4)
  const max = Math.ceil(rawMax / step) * step
  const min = Math.floor(rawMin / step) * step
  const plotW = Math.max(10, width - PAD.left - PAD.right)
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const y = (v: number) => PAD.top + ((max - v) / (max - min)) * plotH
  const band = plotW / Math.max(1, slots.length)
  const barW = Math.max(1, Math.min(24, band - 2))
  const ticks = niceTicks(min, max, 4)
  const hovered = hover !== null ? slots[hover] : undefined
  const hoveredParts = hover !== null ? parts[hover] : undefined

  return (
    <div className="price-stack" ref={wrap}>
      <div className="stack-readout" aria-live="polite">
        {hovered && hoveredParts ? (
          <>
            <strong>{localTime(hovered.start, timeZone)}</strong> {periodLabel(hovered.period)} ·{' '}
            {PARTS.map((p) => `${p.key === 'fees' ? 'Fees' : p.label} ${formatPrice(hoveredParts[p.key], unit, false)}`).join(' + ')}{' '}
            = <strong>{formatPrice(hoveredParts.total, unit)}</strong>
          </>
        ) : (
          <span className="muted">Point at a bar to see what the price is made of.</span>
        )}
      </div>
      <svg width={width} height={HEIGHT} role="img" aria-label="Import price components per quarter-hour" onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="stack-grid" />
            <text x={PAD.left - 6} y={y(t)} className="stack-tick" textAnchor="end" dominantBaseline="middle">
              {(t * f).toFixed(unit === 'cents' ? (step * 100 < 1 ? 1 : 0) : step < 0.01 ? 3 : 2)}
            </text>
          </g>
        ))}
        {slots.map((slot, i) => {
          const p = parts[i]
          if (!p) return null
          const x = PAD.left + i * band + (band - barW) / 2
          const segments: { key: string; from: number; to: number; color: string }[] = []
          // Spot from zero (down if negative); the rest stack upward from the top of the positive part.
          segments.push({ key: 'spot', from: 0, to: p.spot, color: PARTS[0].color })
          let base = Math.max(p.spot, 0)
          for (const part of PARTS.slice(1)) {
            const v = p[part.key]
            segments.push({ key: part.key, from: base, to: base + v, color: part.color })
            base += v
          }
          const current = Date.parse(slot.start) / 1000 <= nowS && nowS < Date.parse(slot.end) / 1000
          return (
            <g
              key={slot.start}
              onPointerEnter={() => setHover(i)}
              opacity={hover === null || hover === i ? 1 : 0.55}
            >
              <rect x={PAD.left + i * band} y={PAD.top} width={band} height={plotH} fill="transparent" />
              {segments.map((s) => {
                const top = y(Math.max(s.from, s.to))
                const bottom = y(Math.min(s.from, s.to))
                const h = bottom - top - 2 // 2 px surface gap between segments
                if (h <= 0.5) return null
                return <rect key={s.key} x={x} y={top + 1} width={barW} height={h} fill={s.color} rx={barW >= 6 ? 1 : 0} />
              })}
              {current && <line x1={x + barW / 2} x2={x + barW / 2} y1={PAD.top} y2={PAD.top + plotH} className="stack-now" />}
            </g>
          )
        })}
        <line x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} className="stack-axis" />
        {slots.map((slot, i) =>
          i % 12 === 0 ? (
            <text key={slot.start} x={PAD.left + i * band + band / 2} y={HEIGHT - 6} className="stack-tick" textAnchor="middle">
              {localTime(slot.start, timeZone)}
            </text>
          ) : null,
        )}
      </svg>
      <ul className="legend">
        {PARTS.map((p) => (
          <li key={p.key}>
            <span className="legend-swatch" style={{ background: p.color }} />
            {p.label}
          </li>
        ))}
      </ul>
    </div>
  )
}
