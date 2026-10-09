import { formatValue } from '../../lib/format'

interface DiffItem {
  path: string
  old?: unknown
  new?: unknown
}

export function DiffList({ diff, secretPaths = [] }: { diff: DiffItem[]; secretPaths?: string[] }) {
  if (diff.length === 0) return <p className="muted">No changes.</p>
  return (
    <ul className="diff-list">
      {diff.map((d) => {
        const secret = secretPaths.includes(d.path)
        return (
          <li key={d.path}>
            <span className="diff-path">{d.path}</span>
            <span className="diff-change">
              {secret ? (
                <span className="diff-new">changed</span>
              ) : (
                <>
                  <span className="diff-old">{formatValue(d.old)}</span> <span aria-hidden="true">to</span>{' '}
                  <span className="diff-new">{formatValue(d.new)}</span>
                </>
              )}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
