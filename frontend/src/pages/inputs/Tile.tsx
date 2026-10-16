import { Fragment, type ReactNode } from 'react'

/** An entity id or payload key that may wrap after its dots and underscores. */
export function Breakable({ text }: { text: string }) {
  const parts = text.split(/(?<=[._])/)
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part}
          {i < parts.length - 1 && <wbr />}
        </Fragment>
      ))}
    </>
  )
}

/** A tile over the Inputs page's charts: a quantity's colour and name, its value, a line under it, and the payload
 *  keys it comes from. */
export function Tile({
  title,
  value,
  sub,
  color,
  keys = [],
}: {
  title: string
  value: ReactNode
  sub?: ReactNode
  /** CSS custom property of the quantity's colour. */
  color?: string
  keys?: string[]
}) {
  return (
    <div className="card">
      <div className="card-title muted">
        {color && <span className="card-swatch" style={{ background: `var(${color})` }} aria-hidden="true" />}
        {title}
      </div>
      <div className="card-value">{value}</div>
      {sub && <div className="cell-sub">{sub}</div>}
      {keys.length > 0 && (
        <div className="sent-keys">
          {keys.map((k) => (
            <code key={k}>
              <Breakable text={k} />
            </code>
          ))}
        </div>
      )}
    </div>
  )
}
