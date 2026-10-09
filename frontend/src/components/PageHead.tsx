import type { ReactNode } from 'react'

export function PageHead({ title, intro, children }: { title: string; intro?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div style={{ marginRight: 'auto' }}>
        <h1>{title}</h1>
        {intro && <p>{intro}</p>}
      </div>
      {children}
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  )
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <div className="notice" data-color="red" role="alert">
      {(error as Error).message}
    </div>
  )
}
