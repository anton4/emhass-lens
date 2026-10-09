// Typed fetch client. Every URL is relative ("./api/...") so it works under Home Assistant Ingress,
// which serves the App below /api/hassio_ingress/<token>/.

import type { FieldError } from './types'

export const API_BASE = '.'

export type ApiErrorKind = 'conflict' | 'invalid' | 'forbidden' | 'not_found' | 'server' | 'network'

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status: number
  readonly errors: FieldError[]
  readonly currentRevision: number | null

  constructor(kind: ApiErrorKind, status: number, message: string, errors: FieldError[] = [], revision: number | null = null) {
    super(message)
    this.kind = kind
    this.status = status
    this.errors = errors
    this.currentRevision = revision
  }
}

function kindFor(status: number): ApiErrorKind {
  if (status === 409) return 'conflict'
  if (status === 422) return 'invalid'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  return 'server'
}

function messageFor(status: number, body: unknown): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail)) return detail.map((d) => (d as { msg?: string }).msg ?? String(d)).join('; ')
  }
  if (status === 409) return 'The settings were changed elsewhere. Reload to see the newest version.'
  return `Request failed (${status})`
}

/** FastAPI request-validation errors use {detail: [{loc: [...], msg}]}; ours use {errors: [{loc, msg}]}. */
function fieldErrors(body: unknown): FieldError[] {
  if (!body || typeof body !== 'object') return []
  if ('errors' in body && Array.isArray((body as { errors: unknown }).errors)) {
    return (body as { errors: FieldError[] }).errors
  }
  if ('detail' in body && Array.isArray((body as { detail: unknown }).detail)) {
    return (body as { detail: { loc: (string | number)[]; msg: string }[] }).detail.map((d) => ({
      loc: d.loc.filter((p) => p !== 'body').join('.'),
      msg: d.msg,
    }))
  }
  return []
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    })
  } catch (err) {
    throw new ApiError('network', 0, `EMHASS Lens is not reachable (${(err as Error).message})`)
  }
  const isJson = response.headers.get('content-type')?.includes('application/json')
  const payload: unknown = isJson ? await response.json().catch(() => null) : await response.text()
  if (!response.ok) {
    const revision =
      payload && typeof payload === 'object' && 'revision' in payload ? Number((payload as { revision: unknown }).revision) : null
    throw new ApiError(kindFor(response.status), response.status, messageFor(response.status, payload), fieldErrors(payload), revision)
  }
  return payload as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
}

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`
}

export function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}
