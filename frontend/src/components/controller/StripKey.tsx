import type { ReactNode } from 'react'
import { AGREE_TONES, type WriteTick } from '../../lib/dayStrip'

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

/** The key under a strip: what the fills mean (`legend`), then what the rows under the marks mean: the "Lens wrote"
 *  row's ticks (`writes`, each with its text and how many that day), the Automation row's agreed and differed, and
 *  `children`. Nothing when there is nothing to say. */
export function StripFooterKey({
  legend,
  writes = [],
  agree,
  children,
}: {
  legend?: ReactNode
  writes?: { kind: WriteTick['kind']; text: string; count: number }[]
  agree: { same: number; differs: number } | null
  children?: ReactNode
}) {
  const ticks = writes.filter((w) => w.count > 0)
  const parts = (['same', 'differs'] as const).filter((state) => (agree?.[state] ?? 0) > 0)
  const rows = ticks.length > 0 || parts.length > 0 || !!children
  return (
    <>
      {legend && <div className="day-strip-footer">{legend}</div>}
      {rows && <RowsKey ticks={ticks} parts={parts} agree={agree}>{children}</RowsKey>}
    </>
  )
}

function RowsKey({
  ticks,
  parts,
  agree,
  children,
}: {
  ticks: { kind: WriteTick['kind']; text: string; count: number }[]
  parts: ('same' | 'differs')[]
  agree: { same: number; differs: number } | null
  children?: ReactNode
}) {
  return (
    <div className="day-strip-footer">
      {ticks.map((w) => (
        <span key={w.kind} className="day-strip-key-item">
          <span className="day-strip-write-swatch" data-kind={w.kind} />
          {w.text} <span className="num">{w.count}</span>
        </span>
      ))}
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
