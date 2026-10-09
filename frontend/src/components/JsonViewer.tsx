import { useState } from 'react'

interface NodeProps {
  name?: string
  value: unknown
  depth: number
  openDepth: number
}

function Scalar({ value }: { value: unknown }) {
  if (value === null) return <span className="json-null">null</span>
  if (typeof value === 'string') return <span className="json-string">"{value}"</span>
  if (typeof value === 'number') return <span className="json-number">{value}</span>
  if (typeof value === 'boolean') return <span className="json-bool">{String(value)}</span>
  return <span>{String(value)}</span>
}

function Key({ name }: { name?: string }) {
  if (name === undefined) return null
  return <span className="json-key">{name}: </span>
}

const BIG_ARRAY = 200

function JsonNode({ name, value, depth, openDepth }: NodeProps) {
  const [showAll, setShowAll] = useState(false)
  if (value === null || typeof value !== 'object') {
    return (
      <div>
        <Key name={name} />
        <Scalar value={value} />
      </div>
    )
  }
  const isArray = Array.isArray(value)
  const entries: [string, unknown][] = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>)
  const count = entries.length
  // Arrays of scalars (price lists, power series) read better on one wrapped line.
  if (isArray && entries.every(([, v]) => v === null || typeof v !== 'object')) {
    const shown = showAll ? entries : entries.slice(0, BIG_ARRAY)
    return (
      <div>
        <Key name={name} />
        <span className="json-count">[{count}] </span>
        {shown.map(([i, v], idx) => (
          <span key={i}>
            <Scalar value={v} />
            {idx < shown.length - 1 ? ', ' : ''}
          </span>
        ))}
        {count > shown.length && (
          <button type="button" className="quiet" onClick={() => setShowAll(true)}>
            Show all {count}
          </button>
        )}
      </div>
    )
  }
  return (
    <details open={depth < openDepth}>
      <summary>
        <Key name={name} />
        <span className="json-count">
          {isArray ? `[${count}]` : `{${count}}`}
        </span>
      </summary>
      <div className="json-children">
        {entries.map(([k, v]) => (
          <JsonNode key={k} name={isArray ? `${k}` : k} value={v} depth={depth + 1} openDepth={openDepth} />
        ))}
      </div>
    </details>
  )
}

/** Collapsible JSON tree; the first `openDepth` levels start expanded. */
export function JsonViewer({ value, openDepth = 2 }: { value: unknown; openDepth?: number }) {
  return (
    <div className="json">
      <JsonNode value={value} depth={0} openDepth={openDepth} />
    </div>
  )
}
