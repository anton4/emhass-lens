import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError, api } from '../../api/client'
import { keys, useRevisions } from '../../api/queries'
import type { Revision, SaveResponse } from '../../api/types'
import { JsonViewer } from '../../components/JsonViewer'
import { Empty, ErrorNotice } from '../../components/PageHead'
import { formatTime } from '../../lib/format'
import { DiffList } from './DiffList'

const SOURCES: Record<string, string> = {
  default: 'Defaults',
  ui: 'Edited',
  import: 'Imported',
  revert: 'Reverted',
  migration: 'Migrated',
  legacy_import: 'Imported from the HACS integration',
}

export function History({ currentRevision, writable, secretPaths }: { currentRevision: number; writable: boolean; secretPaths: string[] }) {
  const revisions = useRevisions()
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>History</h2>
        <span className="muted">Every saved version, newest first</span>
      </div>
      <ErrorNotice error={revisions.error} />
      {(revisions.data ?? []).map((rev) => (
        <RevisionRow
          key={rev.id}
          rev={rev}
          current={rev.id === currentRevision}
          currentRevision={currentRevision}
          writable={writable}
          secretPaths={secretPaths}
        />
      ))}
      {revisions.isSuccess && revisions.data.length === 0 && <Empty title="No revisions yet" />}
    </section>
  )
}

function RevisionRow({
  rev,
  current,
  currentRevision,
  writable,
  secretPaths,
}: {
  rev: Revision
  current: boolean
  currentRevision: number
  writable: boolean
  secretPaths: string[]
}) {
  const queryClient = useQueryClient()
  const [showDoc, setShowDoc] = useState(false)
  const [showDiff, setShowDiff] = useState(rev.diff.length <= 6)
  const [confirm, setConfirm] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const doc = useQuery({
    queryKey: ['settings-revision', rev.id],
    queryFn: () => api.get<unknown>(`/api/settings/revisions/${rev.id}`),
    enabled: showDoc,
    staleTime: Infinity,
  })

  const revert = async () => {
    setError(null)
    try {
      const res = await api.post<SaveResponse>(`/api/settings/revert/${rev.id}`, {
        base_revision: currentRevision,
        comment: null,
      })
      setResult(res.diff.length === 0 ? 'Already the same as the current settings.' : `Reverted: now revision ${res.revision}.`)
      setConfirm(false)
      void queryClient.invalidateQueries({ queryKey: keys.settings })
      void queryClient.invalidateQueries({ queryKey: keys.revisions })
    } catch (err) {
      setError(err instanceof ApiError && err.kind === 'conflict' ? new Error('Someone saved meanwhile; the list has been refreshed.') : err)
      void queryClient.invalidateQueries({ queryKey: keys.revisions })
    }
  }

  return (
    <div className="revision">
      <div className="revision-head">
        <span className="readout">Revision {rev.id}</span>
        {current && (
          <span className="chip" data-color="green">
            Current
          </span>
        )}
        <span className="muted">
          {SOURCES[rev.source] ?? rev.source} by {rev.actor ?? 'unknown'}, <time dateTime={rev.created_at}>{formatTime(rev.created_at)}</time>
        </span>
        <span className="grow" />
        <button type="button" className="quiet" onClick={() => setShowDoc((s) => !s)} aria-expanded={showDoc}>
          {showDoc ? 'Hide settings' : 'View settings'}
        </button>
        {!current && (
          <button type="button" disabled={!writable} onClick={() => setConfirm(true)}>
            Revert to this
          </button>
        )}
      </div>
      {rev.comment && <p style={{ margin: '6px 0 0' }}>{rev.comment}</p>}
      {rev.diff.length > 0 &&
        (showDiff ? (
          <div style={{ marginTop: 8 }}>
            <DiffList diff={rev.diff} secretPaths={secretPaths} />
          </div>
        ) : (
          <button type="button" className="quiet" onClick={() => setShowDiff(true)}>
            Show {rev.diff.length} changes
          </button>
        ))}
      {confirm && (
        <div className="notice" data-color="amber" style={{ marginTop: 10 }}>
          Reverting saves revision {rev.id}'s settings as a new revision and applies them right away.{' '}
          <button type="button" className="primary" onClick={revert}>
            Revert to revision {rev.id}
          </button>{' '}
          <button type="button" onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </div>
      )}
      {result && (
        <div className="notice" data-color="green" style={{ marginTop: 10 }}>
          {result}
        </div>
      )}
      <ErrorNotice error={error} />
      {showDoc && (
        <div style={{ marginTop: 10 }}>
          {doc.isLoading && <span className="muted">Loading…</span>}
          {doc.isSuccess && <JsonViewer value={doc.data} openDepth={1} />}
        </div>
      )}
    </div>
  )
}
