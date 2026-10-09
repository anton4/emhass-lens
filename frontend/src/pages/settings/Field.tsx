import { useState } from 'react'
import { deepEqual } from '../../lib/diff'
import { formatQuarterOffset } from '../../lib/format'
import { defaultFor, fieldInfo, getPath, hasErrorsUnder, type FieldInfo, type SchemaNode } from '../../lib/schema'

export const MASK = '********'

export interface FormContext {
  draft: unknown
  original: unknown
  errors: Map<string, string[]>
  showAdvanced: boolean
  disabled: boolean
  onChange: (path: (string | number)[], value: unknown) => void
  onLocalError: (path: string, message: string | null) => void
}

interface FieldProps {
  name: string
  node: SchemaNode
  path: (string | number)[]
  ctx: FormContext
  depth: number
}

function pathKey(path: (string | number)[]): string {
  return path.join('.')
}

function idFor(path: (string | number)[]): string {
  return `f-${path.join('-')}`
}

/** Renders one property: an object becomes a group of fields, everything else an input row. */
export function Field({ name, node, path, ctx, depth }: FieldProps) {
  const info = fieldInfo(name, node)
  const key = pathKey(path)
  const value = getPath(ctx.draft, path)
  const original = getPath(ctx.original, path)
  const modified = !deepEqual(value, original)
  const ownErrors = ctx.errors.get(key) ?? []
  const nestedErrors = hasErrorsUnder(ctx.errors, key)

  if (info.ui.advanced && !ctx.showAdvanced && !modified && !nestedErrors) return null

  if (info.kind === 'object') {
    return <ObjectGroup info={info} path={path} ctx={ctx} depth={depth} ownErrors={ownErrors} />
  }
  if (info.kind === 'list') {
    return <ListField info={info} path={path} ctx={ctx} depth={depth} value={value} ownErrors={ownErrors} />
  }

  const id = idFor(path)
  return (
    <div className={`field${modified ? ' field-modified' : ''}`}>
      <label className="field-label" htmlFor={id}>
        {info.title}
        {info.ui.advanced && <span className="advanced-tag">advanced</span>}
      </label>
      <div className="field-input">
        <Input id={id} info={info} path={path} value={value} ctx={ctx} invalid={ownErrors.length > 0} />
      </div>
      {info.description && <p className="field-help">{info.description}</p>}
      {ownErrors.map((msg) => (
        <p key={msg} className="field-error" role="alert">
          {msg}
        </p>
      ))}
    </div>
  )
}

function ObjectGroup({
  info,
  path,
  ctx,
  depth,
  ownErrors,
}: {
  info: FieldInfo
  path: (string | number)[]
  ctx: FormContext
  depth: number
  ownErrors: string[]
}) {
  const properties = Object.entries(info.node.properties ?? {})
  const fields = properties.map(([childName, childNode]) => (
    <Field key={childName} name={childName} node={childNode} path={[...path, childName]} ctx={ctx} depth={depth + 1} />
  ))
  if (depth === 0) {
    // A top-level section: its own scalar fields first, then nested groups.
    const scalars = properties.filter(([n, c]) => !['object', 'list'].includes(fieldInfo(n, c).kind))
    const groups = properties.filter(([n, c]) => ['object', 'list'].includes(fieldInfo(n, c).kind))
    return (
      <div className="form-section">
        {ownErrors.length > 0 && (
          <div className="group">
            {ownErrors.map((msg) => (
              <p key={msg} className="field-error" role="alert" style={{ margin: 0 }}>
                {msg}
              </p>
            ))}
          </div>
        )}
        {scalars.length > 0 && (
          <div className="group">
            {scalars.map(([childName, childNode]) => (
              <Field key={childName} name={childName} node={childNode} path={[...path, childName]} ctx={ctx} depth={1} />
            ))}
          </div>
        )}
        {groups.map(([childName, childNode]) => (
          <Field key={childName} name={childName} node={childNode} path={[...path, childName]} ctx={ctx} depth={1} />
        ))}
      </div>
    )
  }
  return (
    <div className="group">
      <h3>{info.title}</h3>
      {info.description && <p className="field-help" style={{ gridColumn: 'auto', marginBottom: 8 }}>{info.description}</p>}
      {ownErrors.map((msg) => (
        <p key={msg} className="field-error" role="alert">
          {msg}
        </p>
      ))}
      {fields}
    </div>
  )
}

function ListField({
  info,
  path,
  ctx,
  depth,
  value,
  ownErrors,
}: {
  info: FieldInfo
  path: (string | number)[]
  ctx: FormContext
  depth: number
  value: unknown
  ownErrors: string[]
}) {
  const items = Array.isArray(value) ? value : []
  const itemNode = info.node.items ?? {}
  const max = info.node.maxItems
  const itemTitle = (item: unknown, index: number) => {
    const name = item && typeof item === 'object' && 'name' in item ? String((item as { name: unknown }).name) : ''
    return name || `Item ${index + 1}`
  }
  return (
    <div className="group">
      <h3>{info.title}</h3>
      {info.description && <p className="field-help" style={{ gridColumn: 'auto' }}>{info.description}</p>}
      {ownErrors.map((msg) => (
        <p key={msg} className="field-error" role="alert">
          {msg}
        </p>
      ))}
      {items.map((item, index) => (
        <div key={index} className="list-item">
          <div className="list-item-head">
            <strong>{itemTitle(item, index)}</strong>
            <button
              type="button"
              className="quiet"
              disabled={ctx.disabled}
              onClick={() => ctx.onChange(path, items.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          </div>
          {Object.entries(itemNode.properties ?? {}).map(([childName, childNode]) => (
            <Field
              key={childName}
              name={childName}
              node={childNode}
              path={[...path, index, childName]}
              ctx={ctx}
              depth={depth + 2}
            />
          ))}
        </div>
      ))}
      {items.length === 0 && <p className="muted">None.</p>}
      <button
        type="button"
        disabled={ctx.disabled || (max !== undefined && items.length >= max)}
        onClick={() => ctx.onChange(path, [...items, defaultFor(itemNode)])}
      >
        Add {info.title.toLowerCase().replace(/s$/, '')}
      </button>
    </div>
  )
}

interface InputProps {
  id: string
  info: FieldInfo
  path: (string | number)[]
  value: unknown
  ctx: FormContext
  invalid: boolean
}

function Input({ id, info, path, value, ctx, invalid }: InputProps) {
  const set = (v: unknown) => ctx.onChange(path, v)
  const common = { id, disabled: ctx.disabled, 'aria-invalid': invalid || undefined }
  const unit = info.ui.unit ? <span className="field-unit">{info.ui.unit}</span> : null

  switch (info.kind) {
    case 'boolean':
      return (
        <label className="toggle">
          <input type="checkbox" role="switch" {...common} checked={Boolean(value)} onChange={(e) => set(e.target.checked)} />
          <span className="muted">{value ? 'On' : 'Off'}</span>
        </label>
      )
    case 'enum': {
      const labels = info.ui.labels ?? {}
      return (
        <select
          {...common}
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(e) => set(e.target.value === '' && info.nullable ? null : e.target.value)}
        >
          {info.nullable && <option value="">—</option>}
          {(info.node.enum ?? []).map((option) => (
            <option key={String(option)} value={String(option)}>
              {labels[String(option)] ?? String(option)}
            </option>
          ))}
        </select>
      )
    }
    case 'integer':
    case 'number':
      return (
        <>
          <NumberInput {...common} info={info} value={value} onValue={set} />
          {unit}
          {info.ui.widget === 'quarter_offset' && typeof value === 'number' && (
            <span className="field-unit">fires at {formatQuarterOffset(value)}</span>
          )}
        </>
      )
    case 'dict':
      return <JsonInput {...common} path={path} value={value} ctx={ctx} />
    case 'string': {
      const widget = info.ui.widget
      if (widget === 'secret') {
        return (
          <>
            <input
              {...common}
              type="password"
              autoComplete="off"
              placeholder={value === MASK ? 'Stored; type to replace' : 'Not set'}
              value={value === MASK ? '' : String(value ?? '')}
              onChange={(e) => set(e.target.value === '' && value === MASK ? MASK : e.target.value)}
            />
            {value === MASK && (
              <button type="button" className="quiet" disabled={ctx.disabled} onClick={() => set('')}>
                Remove
              </button>
            )}
          </>
        )
      }
      const type = widget === 'time' ? 'time' : widget === 'url' ? 'url' : 'text'
      return (
        <>
          <input
            {...common}
            type={type}
            spellCheck={false}
            placeholder={widget === 'entity' ? entityPlaceholder(info) : undefined}
            value={value === null || value === undefined ? '' : String(value)}
            onChange={(e) => set(e.target.value === '' && info.nullable ? null : e.target.value)}
          />
          {unit}
        </>
      )
    }
    default:
      return <code>{JSON.stringify(value)}</code>
  }
}

function entityPlaceholder(info: FieldInfo): string {
  const domain = info.ui.domain
  const first = Array.isArray(domain) ? domain[0] : domain
  return `${first ?? 'sensor'}.example`
}

function parseNumber(t: string): number | null | undefined {
  if (t.trim() === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

function NumberInput({
  id,
  disabled,
  info,
  value,
  onValue,
  ...rest
}: {
  id: string
  disabled: boolean
  info: FieldInfo
  value: unknown
  onValue: (v: unknown) => void
  'aria-invalid'?: boolean
}) {
  const external = value === null || value === undefined ? '' : String(value)
  const [text, setText] = useState(external)
  const [seen, setSeen] = useState(external)
  // Follow outside changes (reload, revert) without clobbering what is being typed ("0." etc.).
  if (seen !== external) {
    setSeen(external)
    if (parseNumber(text) !== (value ?? null)) setText(external)
  }
  const parse = parseNumber

  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      className="num"
      disabled={disabled}
      aria-invalid={rest['aria-invalid']}
      min={info.node.minimum}
      max={info.node.maximum}
      step={info.kind === 'integer' ? 1 : 'any'}
      placeholder={info.nullable ? 'Not set' : undefined}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        const parsed = parse(e.target.value)
        if (parsed === undefined) return
        if (parsed === null) {
          onValue(info.nullable ? null : '')
          return
        }
        onValue(info.kind === 'integer' ? Math.trunc(parsed) : parsed)
      }}
    />
  )
}

function sameJson(text: string, value: unknown): boolean {
  try {
    return deepEqual(JSON.parse(text), value)
  } catch {
    return false
  }
}

function JsonInput({
  id,
  disabled,
  path,
  value,
  ctx,
}: {
  id: string
  disabled: boolean
  path: (string | number)[]
  value: unknown
  ctx: FormContext
}) {
  const external = JSON.stringify(value ?? {}, null, 2)
  const [text, setText] = useState(external)
  const [error, setError] = useState<string | null>(null)
  const key = pathKey(path)

  const [seen, setSeen] = useState(external)
  if (seen !== external) {
    setSeen(external)
    if (!sameJson(text, value ?? {}) && error === null) setText(external)
  }

  return (
    <div style={{ width: '100%' }}>
      <textarea
        id={id}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        spellCheck={false}
        rows={Math.min(10, Math.max(3, text.split('\n').length))}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          try {
            const parsed = JSON.parse(e.target.value || '{}') as unknown
            setError(null)
            ctx.onLocalError(key, null)
            ctx.onChange(path, parsed)
          } catch (err) {
            const msg = `Not valid JSON: ${(err as Error).message}`
            setError(msg)
            ctx.onLocalError(key, msg)
          }
        }}
      />
      {error && (
        <p className="field-error" role="alert" style={{ margin: '4px 0 0' }}>
          {error}
        </p>
      )}
    </div>
  )
}
