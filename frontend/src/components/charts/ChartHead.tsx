import type { CSSProperties, ReactNode } from 'react'

/** A key entry in a chart's head: a swatch drawn the way the chart draws it, and its name. */
export interface ChartKeyItem {
  label: ReactNode
  /** CSS custom property or colour. */
  color: string
  /** A line, the same faded (the plan), dashed, an area, hatched, or a gradient of `gradient`'s colours. */
  look: 'line' | 'faded' | 'dash' | 'area' | 'hatch' | 'gradient'
  gradient?: string[]
  title?: string
}

const css = (color: string) => (color.startsWith('--') ? `var(${color})` : color)

/** A chart's head: its title and unit, a key of what it draws, anything else (`children`), and what it adds up for the
 *  window shown at the right. */
export function ChartHead({
  title,
  unit,
  keys = [],
  summary,
  children,
}: {
  title: ReactNode
  unit?: ReactNode
  keys?: ChartKeyItem[]
  summary?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="chart-head">
      <h3>
        {title}
        {unit && <span className="chart-unit">{unit}</span>}
      </h3>
      {keys.length > 0 && (
        <ul className="chart-keys" aria-label="Key">
          {keys.map((k, i) => (
            <li key={i} title={k.title}>
              <span
                className="chart-key-swatch"
                data-look={k.look}
                style={
                  {
                    '--key': css(k.color),
                    ...(k.gradient ? { background: `linear-gradient(90deg, ${k.gradient.map(css).join(', ')})` } : {}),
                  } as CSSProperties
                }
                aria-hidden="true"
              />
              {k.label}
            </li>
          ))}
        </ul>
      )}
      {children}
      {summary && <span className="chart-summary">{summary}</span>}
    </div>
  )
}
