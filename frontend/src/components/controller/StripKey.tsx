import type { ReactNode } from 'react'
import { AGREE_TONES } from '../../lib/dayStrip'

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

/** What the rows under the marks mean: the Automation row's agreed and differed, with how many slots or decisions
 *  each today, then `children` (the other rows' keys). Nothing when there is nothing to say. */
export function StripFooterKey({
  agree,
  children,
}: {
  agree: { same: number; differs: number } | null
  children?: ReactNode
}) {
  const parts = (['same', 'differs'] as const).filter((state) => (agree?.[state] ?? 0) > 0)
  if (parts.length === 0 && !children) return null
  return (
    <div className="day-strip-footer">
      {parts.map((state) => (
        <span key={state} className="day-strip-key-item">
          <span className="day-strip-swatch wide" style={{ background: AGREE_TONES[state].fill }} />
          automation {AGREE_TONES[state].text} <span className="num">{agree?.[state]}</span>
        </span>
      ))}
      {children}
    </div>
  )
}
