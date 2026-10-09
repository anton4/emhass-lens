// Walking the settings JSON schema (refs already inlined by the backend) to render forms.

export interface UiHints {
  unit?: string
  widget?: 'entity' | 'secret' | 'time' | 'quarter_offset' | 'json' | 'url' | string
  advanced?: boolean
  domain?: string | string[]
  help?: string
  labels?: Record<string, string>
}

export interface SchemaNode {
  type?: string | string[]
  title?: string
  description?: string
  default?: unknown
  enum?: unknown[]
  const?: unknown
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  minLength?: number
  maxLength?: number
  maxItems?: number
  pattern?: string
  properties?: Record<string, SchemaNode>
  required?: string[]
  items?: SchemaNode
  additionalProperties?: SchemaNode | boolean
  anyOf?: SchemaNode[]
  ui?: UiHints
}

export type FieldKind = 'object' | 'enum' | 'boolean' | 'integer' | 'number' | 'string' | 'list' | 'dict' | 'unknown'

export interface FieldInfo {
  kind: FieldKind
  nullable: boolean
  /** The non-null branch for anyOf [X, null], or the node itself. */
  node: SchemaNode
  title: string
  description?: string
  ui: UiHints
}

function typeOf(node: SchemaNode): string | undefined {
  if (Array.isArray(node.type)) return node.type.find((t) => t !== 'null')
  return node.type
}

function isNullNode(node: SchemaNode): boolean {
  return node.type === 'null'
}

/** Resolve a property schema into what the form needs: kind, nullability, labels and hints. */
export function fieldInfo(name: string, raw: SchemaNode): FieldInfo {
  let node = raw
  let nullable = Array.isArray(raw.type) && raw.type.includes('null')
  if (raw.anyOf && raw.anyOf.length > 0) {
    const nonNull = raw.anyOf.filter((n) => !isNullNode(n))
    nullable = nullable || nonNull.length < raw.anyOf.length
    if (nonNull.length === 1 && nonNull[0]) {
      // Keep the outer title/description/default/ui; take type info from the branch.
      node = { ...nonNull[0], ...stripAnyOf(raw) }
    }
  }
  const ui: UiHints = { ...(node.ui ?? {}), ...(raw.ui ?? {}) }
  // Nested models without their own field title inherit the class name ("EmhassMpc"); use the key.
  const candidate = raw.title ?? node.title
  const title = candidate && !CLASS_NAME.test(candidate) ? candidate : humanize(name)
  return { kind: kindOf(node, ui), nullable, node, title, description: raw.description ?? node.description, ui }
}

function stripAnyOf(raw: SchemaNode): SchemaNode {
  const { anyOf: _anyOf, ...rest } = raw
  return rest
}

function kindOf(node: SchemaNode, ui: UiHints): FieldKind {
  if (node.enum) return 'enum'
  const t = typeOf(node)
  if (t === 'object') {
    if (node.properties) return 'object'
    if (ui.widget === 'json' || node.additionalProperties !== undefined) return 'dict'
    return 'dict'
  }
  if (t === 'array') return node.items && typeOf(node.items) === 'object' ? 'list' : 'dict'
  if (t === 'boolean') return 'boolean'
  if (t === 'integer') return 'integer'
  if (t === 'number') return 'number'
  if (t === 'string') return 'string'
  return 'unknown'
}

const CLASS_NAME = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+$/

const ACRONYMS: Record<string, string> = {
  mpc: 'MPC',
  ml: 'ML',
  ee: 'EE',
  fi: 'FI',
  pv: 'PV',
  soc: 'SOC',
  url: 'URL',
  vat: 'VAT',
  mqtt: 'MQTT',
  emhass: 'EMHASS',
  ha: 'HA',
  api: 'API',
}

/** "slot_offset_s" -> "Slot offset s", "mpc" -> "MPC" for fields without a usable title. */
export function humanize(name: string): string {
  const words = name.split('_').map((w) => ACRONYMS[w] ?? w)
  const text = words.join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Whether the field (or every leaf of an object field) is marked advanced. */
export function isAdvanced(info: FieldInfo): boolean {
  return Boolean(info.ui.advanced)
}

export function getPath(doc: unknown, path: (string | number)[]): unknown {
  let node: unknown = doc
  for (const part of path) {
    if (node === null || node === undefined || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[String(part)]
  }
  return node
}

/** Immutable set: returns a copy of `doc` with `value` at `path`. */
export function setPath<T>(doc: T, path: (string | number)[], value: unknown): T {
  if (path.length === 0) return value as T
  const [head, ...rest] = path
  if (Array.isArray(doc)) {
    const copy = [...doc]
    const index = Number(head)
    copy[index] = setPath(copy[index], rest, value)
    return copy as T
  }
  const obj = (doc ?? {}) as Record<string, unknown>
  return { ...obj, [String(head)]: setPath(obj[String(head)], rest, value) } as T
}

/** Default value for a new list item (e.g. a deferrable load) from the item schema. */
export function defaultFor(node: SchemaNode): unknown {
  if (node.default !== undefined) return structuredClone(node.default)
  const t = typeOf(node)
  if (t === 'object' && node.properties) {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(node.properties)) {
      const info = fieldInfo(key, child)
      out[key] = info.node.default !== undefined ? structuredClone(info.node.default) : defaultFor(info.node)
    }
    return out
  }
  if (t === 'array') return []
  if (t === 'boolean') return false
  if (t === 'integer' || t === 'number') return 0
  if (t === 'string') return ''
  return null
}

/** Group server validation errors (dotted loc) by path for inline display. */
export function errorsByPath(errors: { loc: string; msg: string }[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const err of errors) {
    const list = map.get(err.loc) ?? []
    list.push(err.msg)
    map.set(err.loc, list)
  }
  return map
}

/** Errors at a path or nested under it (for marking sections that contain errors). */
export function hasErrorsUnder(errors: Map<string, string[]>, path: string): boolean {
  for (const key of errors.keys()) {
    if (key === path || key.startsWith(`${path}.`) || (path === '' && key === '')) return true
  }
  return false
}

/** Dotted paths of fields with ui.widget = secret (shown as "changed" in diffs, never as values). */
export function secretPathsOf(schema: SchemaNode, prefix = ''): string[] {
  const out: string[] = []
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key
    const info = fieldInfo(key, child)
    if (info.ui.widget === 'secret') out.push(path)
    if (info.kind === 'object') out.push(...secretPathsOf(info.node, path))
  }
  return out
}
