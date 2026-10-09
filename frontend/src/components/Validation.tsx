import type { Issue } from '../api/types'
import { Lamp } from './Lamp'

/** Findings of a payload check: errors stop a live run, warnings are recorded. */
export function ValidationList({ issues }: { issues: Issue[] }) {
  if (issues.length === 0) {
    return (
      <p className="validation-ok">
        <Lamp color="green" /> No findings: this payload would be sent as is.
      </p>
    )
  }
  const order: Record<string, number> = { error: 0, warning: 1, info: 2 }
  const rank = (level: string) => order[level] ?? 3
  const sorted = [...issues].sort((a, b) => rank(a.level) - rank(b.level))
  return (
    <ul className="issues">
      {sorted.map((issue, i) => (
        <li key={`${issue.code}-${i}`} data-level={issue.level}>
          <Lamp color={issue.level === 'error' ? 'red' : issue.level === 'warning' ? 'amber' : 'blue'} />
          <div>
            <div>
              <strong>{issue.level === 'error' ? 'Error' : issue.level === 'warning' ? 'Warning' : 'Note'}</strong>{' '}
              {issue.message}
            </div>
            {issue.hint && <div className="cell-sub">{issue.hint}</div>}
          </div>
        </li>
      ))}
    </ul>
  )
}
