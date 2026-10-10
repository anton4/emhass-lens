import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PriceSlot } from '../../api/types'
import { importComponents, localTime, periodLabel, PRICE_PARTS, stackExtent, stackSegments, type PricePart } from '../../lib/prices'
import { formatPrice, priceFactor, type PriceUnit } from '../../lib/units'

// Spot in its own colour (as on every chart); what is added on top of it in greys, from light to dark to light so
// neighbours always differ in lightness. VAT is nearly white, so it gets an outline.
const PARTS: readonly { key: PricePart; label: string; color: string; line?: string }[] = [
  { key: 'spot', label: 'Spot', color: 'var(--q-spot)' },
  { key: 'fees', label: 'Fees (margin, renewable, excise, balancing, supply security)', color: 'var(--stack-fees)' },
  { key: 'network', label: 'Network', color: 'var(--stack-network)' },
  { key: 'vat', label: 'VAT', color: 'var(--stack-vat)', line: 'var(--stack-vat-line)' },
]
const COLORS = Object.fromEntries(PARTS.map((p) => [p.key, p.color])) as Record<PricePart, string>
const LINES = Object.fromEntries(PARTS.map((p) => [p.key, p.line])) as Record<PricePart, string | undefined>

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
  const [shown, setShown] = useState<Set<PricePart>>(loadShown)
  useEffect(() => saveShown(shown), [shown])
  const toggle = (key: PricePart) =>
    setShown((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

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
  const { min: rawMin, max: rawMax } = stackExtent(parts, shown)
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
            {PARTS.map((p, i) => (
              <span key={p.key} className={shown.has(p.key) ? undefined : 'muted'}>
                {i > 0 && ' + '}
                {p.key === 'fees' ? 'Fees' : p.label} {formatPrice(hoveredParts[p.key], unit, false)}
              </span>
            ))}{' '}
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
          const segments = stackSegments(p, shown)
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
                const line = LINES[s.key]
                return (
                  <rect
                    key={s.key}
                    x={x + (line ? 0.5 : 0)}
                    y={top + (line ? 1.5 : 1)}
                    width={line ? Math.max(0.5, barW - 1) : barW}
                    height={line ? Math.max(0.5, h - 1) : h}
                    style={{ fill: COLORS[s.key], stroke: line, strokeWidth: line ? 1 : undefined }}
                    rx={barW >= 6 ? 1 : 0}
                  />
                )
              })}
              {current && <line x1={x + barW / 2} x2={x + barW / 2} y1={PAD.top} y2={PAD.top + plotH} className="stack-now" />}
            </g>
          )
        })}
        <line x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} className="stack-axis" />
        {shown.size === 0 && (
          <text x={PAD.left + plotW / 2} y={PAD.top + plotH / 2} className="stack-empty" textAnchor="middle" dominantBaseline="middle">
            Choose at least one part below.
          </text>
        )}
        {slots.map((slot, i) =>
          i % 12 === 0 ? (
            <text key={slot.start} x={PAD.left + i * band + band / 2} y={HEIGHT - 6} className="stack-tick" textAnchor="middle">
              {localTime(slot.start, timeZone)}
            </text>
          ) : null,
        )}
      </svg>
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
              <span
                className="legend-swatch"
                style={{ background: p.color, color: p.line ?? p.color, boxShadow: p.line ? `inset 0 0 0 1px ${p.line}` : undefined }}
              />
              {p.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
