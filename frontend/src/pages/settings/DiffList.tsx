import { useSettingsSchema } from '../../api/queries'
import { formatValue } from '../../lib/format'
import { locatePath } from '../../lib/schema'

interface DiffItem {
  path: string
  old?: unknown
  new?: unknown
}

interface DiffListProps {
  diff: DiffItem[]
  secretPaths?: string[]
  /** Show the changed field in the form (the location becomes a button). */
  onLocate?: (fieldPath: string[]) => void
  /** Undo one change (adds a Revert button per line). */
  onRevert?: (path: string) => void
}

export function DiffList({ diff, secretPaths = [], onLocate, onRevert }: DiffListProps) {
  const schema = useSettingsSchema()
  if (diff.length === 0) return <p className="muted">No changes.</p>
  return (
    <ul className="diff-list">
      {diff.map((d) => {
        const secret = secretPaths.includes(d.path)
        const where = schema.data ? locatePath(schema.data, d.path) : null
        const label = where ? where.titles.join(' › ') : d.path
        return (
          <li key={d.path}>
            <span className="diff-where">
              {onLocate && where && where.fieldPath.length > 0 ? (
                <button
                  type="button"
                  className="quiet diff-locate"
                  title="Show this field"
                  onClick={() => onLocate(where.fieldPath)}
                >
                  {label}
                </button>
              ) : (
                <span className="diff-label">{label}</span>
              )}
              {where && <span className="diff-path">{d.path}</span>}
            </span>
            <span className="diff-change">
              {secret ? (
                <span className="diff-new">changed</span>
              ) : (
                <>
                  <span className="diff-old">{formatValue(d.old)}</span> <span aria-hidden="true">to</span>{' '}
                  <span className="diff-new">{formatValue(d.new)}</span>
                </>
              )}
              {onRevert && (
                <button type="button" className="quiet diff-revert" onClick={() => onRevert(d.path)}>
                  Revert
                </button>
              )}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
