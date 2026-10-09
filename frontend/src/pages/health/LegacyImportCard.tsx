import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError, api } from '../../api/client'
import { keys, useLegacyPreview, useSettings } from '../../api/queries'
import type { SaveResponse } from '../../api/types'
import { ErrorNotice } from '../../components/PageHead'
import { DiffList } from '../settings/DiffList'

/** Copy tariffs, the API key and forecast choices from the HACS integration into EMHASS Lens. */
export function LegacyImportCard({ writable }: { writable: boolean }) {
  const [asked, setAsked] = useState(false)
  const preview = useLegacyPreview(asked)
  const settings = useSettings()
  const queryClient = useQueryClient()
  const apply = useMutation({
    mutationFn: () => api.post<SaveResponse>('/api/legacy/import', { base_revision: settings.data?.revision ?? null }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.settings })
      void queryClient.invalidateQueries({ queryKey: keys.revisions })
      void queryClient.invalidateQueries({ queryKey: keys.legacy })
    },
  })
  const p = preview.data
  const conflict = apply.error instanceof ApiError && apply.error.kind === 'conflict'

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Import from the HACS integration</h2>
        <button type="button" disabled={preview.isFetching} onClick={() => (asked ? void preview.refetch() : setAsked(true))}>
          {preview.isFetching ? 'Reading…' : asked ? 'Read again' : 'Read its settings'}
        </button>
      </div>
      <div className="panel-body">
        {!asked && (
          <p className="muted" style={{ margin: 0 }}>
            Reads the integration's tariffs, eupowerprices.com API key and forecast choices (through its options form,
            which is opened and closed again) and shows what would change here before anything is saved.
          </p>
        )}
        <ErrorNotice error={preview.error} />
        {p && (
          <>
            {p.notes.length > 0 && (
              <ul className="plain-list">
                {p.notes.map((n) => (
                  <li key={n} className="cell-sub">
                    {n}
                  </li>
                ))}
              </ul>
            )}
            {!p.found ? (
              <p className="muted">The HACS integration wasn't found.</p>
            ) : p.errors.length > 0 ? (
              <div className="notice" data-color="red">
                The imported values don't validate: {p.errors.map((e) => `${e.loc}: ${e.msg}`).join('; ')}
              </div>
            ) : p.diff.length === 0 ? (
              <p className="muted">Nothing to import: the settings already match.</p>
            ) : (
              <>
                <DiffList diff={p.diff} />
                <div className="toolbar" style={{ marginTop: 12 }}>
                  <button type="button" className="primary" disabled={!writable || apply.isPending} onClick={() => apply.mutate()}>
                    Import {p.diff.length} change{p.diff.length === 1 ? '' : 's'}
                  </button>
                </div>
              </>
            )}
          </>
        )}
        {apply.data && (
          <div className="notice" data-color="green">
            Saved as revision {apply.data.revision}.
          </div>
        )}
        {conflict ? (
          <div className="notice" data-color="amber">
            The settings changed meanwhile. Read the integration again and retry.
          </div>
        ) : (
          <ErrorNotice error={apply.error} />
        )}
      </div>
    </section>
  )
}
