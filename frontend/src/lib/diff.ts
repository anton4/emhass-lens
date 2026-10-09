// Leaf-level differences between two settings documents, mirroring the backend's diff_docs:
// objects are walked, lists and scalars compare as whole values.

export interface DiffEntry {
  path: string
  old: unknown
  new: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) {
      if (!deepEqual(a[key], b[key])) return false
    }
    return true
  }
  return false
}

export function diffDocs(oldDoc: unknown, newDoc: unknown, path = ''): DiffEntry[] {
  if (isPlainObject(oldDoc) && isPlainObject(newDoc)) {
    const keys: string[] = []
    for (const key of [...Object.keys(oldDoc), ...Object.keys(newDoc)]) {
      if (!keys.includes(key)) keys.push(key)
    }
    const out: DiffEntry[] = []
    for (const key of keys) {
      const sub = path ? `${path}.${key}` : key
      if (!(key in oldDoc)) out.push({ path: sub, old: null, new: newDoc[key] })
      else if (!(key in newDoc)) out.push({ path: sub, old: oldDoc[key], new: null })
      else out.push(...diffDocs(oldDoc[key], newDoc[key], sub))
    }
    return out
  }
  return deepEqual(oldDoc, newDoc) ? [] : [{ path, old: oldDoc, new: newDoc }]
}
