import { Link } from 'react-router'
import type { ProblemInfo } from '../api/types'
import { formatTime } from '../lib/format'
import { Lamp } from './Lamp'

/** Turns "#/inputs" (API link) into a router path. */
function route(link: string | null | undefined): string | null {
  if (!link) return null
  return link.replace(/^#/, '') || '/'
}

export function ProblemList({ problems }: { problems: ProblemInfo[] }) {
  return (
    <ul className="problems">
      {problems.map((p) => {
        const to = route(p.link)
        return (
          <li key={p.key} data-severity={p.severity}>
            <Lamp color={p.severity === 'error' ? 'red' : 'amber'} label={p.severity} />
            <div>
              <div className="cell-title">
                {p.title}
                {to && (
                  <>
                    {' '}
                    <Link to={to} className="quiet-link">
                      Open
                    </Link>
                  </>
                )}
              </div>
              {p.detail && <div>{p.detail}</div>}
              {p.hint && <div className="cell-sub">{p.hint}</div>}
              <div className="cell-sub">since {formatTime(p.since)}</div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
