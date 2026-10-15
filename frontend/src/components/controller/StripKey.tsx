import type { ReactNode } from 'react'
import { STRIP_BAND, type StripInput } from '../../lib/dayStrip'

/** What a day strip's fills mean, with how many slots or decisions each today; `children` add more (button presses). */
export function StripKey({
  items,
  children,
}: {
  items: { text: string; fill: string; count: number }[]
  children?: ReactNode
}) {
  return (
    <>
      {items.map((k) => (
        <span key={k.text} className="day-strip-key-item">
          <span className="day-strip-swatch" style={{ background: k.fill }} />
          {k.text} <span className="num">{k.count}</span>
        </span>
      ))}
      {children}
    </>
  )
}

/** What the line under a filled strip means: the comparison (dry run, shadow) and the writes (live) to `target`. */
export function StripLine({ strip, target }: { strip: StripInput<unknown>[]; target: string }) {
  const count = (band: string) => strip.filter((s) => s.band === band).length
  const parts = [
    { band: STRIP_BAND.same, text: 'same as the automation' },
    { band: STRIP_BAND.differs, text: 'the automation differed' },
    { band: STRIP_BAND.wrote, text: `wrote to the ${target}` },
  ]
    .map((p) => ({ ...p, n: count(p.band) }))
    .filter((p) => p.n > 0)
  if (parts.length === 0) return null
  return (
    <>
      <span>Line under the strip:</span>
      {parts.map((p) => (
        <span key={p.band} className="day-strip-key-item">
          <span className="day-strip-swatch line" style={{ background: p.band }} />
          <span className="num">{p.n}</span> {p.text}
        </span>
      ))}
    </>
  )
}
