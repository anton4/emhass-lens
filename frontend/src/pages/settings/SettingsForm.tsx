import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { ApiError, api } from '../../api/client'
import { keys } from '../../api/queries'
import type { SaveResponse, SettingsResponse } from '../../api/types'
import { Lamp } from '../../components/Lamp'
import { diffDocs } from '../../lib/diff'
import { errorsByPath, fieldInfo, hasErrorsUnder, secretPathsOf, setPath, type SchemaNode } from '../../lib/schema'
import { DiffList } from './DiffList'
import { Field, type FormContext } from './Field'

interface Props {
  schema: SchemaNode
  server: SettingsResponse
}

type Notice = { color: 'green' | 'red' | 'amber'; text: string; reload?: boolean } | null

export function SettingsForm({ schema, server }: Props) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<unknown>(server.settings)
  const [base, setBase] = useState<{ revision: number; doc: unknown }>({ revision: server.revision, doc: server.settings })
  const [searchParams] = useSearchParams()
  const [section, setSection] = useState<string>(() => {
    const sections = Object.keys(schema.properties ?? {})
    const wanted = searchParams.get('section')
    return wanted && sections.includes(wanted) ? wanted : (sections[0] ?? '')
  })
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [errors, setErrors] = useState<{ loc: string; msg: string }[]>([])
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({})
  const [confirming, setConfirming] = useState(false)
  const [comment, setComment] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)

  const diff = useMemo(() => diffDocs(base.doc, draft), [base.doc, draft])
  const dirty = diff.length > 0
  const errorMap = useMemo(() => errorsByPath(errors), [errors])
  const secretPaths = useMemo(() => secretPathsOf(schema), [schema])
  const hasLocalErrors = Object.keys(localErrors).length > 0
  const changedElsewhere = server.revision !== base.revision

  // A newer revision arrived (saved elsewhere, revert, import): adopt it if nothing is being edited.
  const [seenRevision, setSeenRevision] = useState(server.revision)
  if (seenRevision !== server.revision) {
    setSeenRevision(server.revision)
    if (!dirty) {
      setBase({ revision: server.revision, doc: server.settings })
      setDraft(server.settings)
    }
  }

  const onChange = useCallback((path: (string | number)[], value: unknown) => {
    setDraft((d: unknown) => setPath(d, path, value))
    setConfirming(false)
  }, [])

  const onLocalError = useCallback((path: string, message: string | null) => {
    setLocalErrors((prev) => {
      if (message === null) {
        if (!(path in prev)) return prev
        const { [path]: _removed, ...rest } = prev
        return rest
      }
      return prev[path] === message ? prev : { ...prev, [path]: message }
    })
  }, [])

  const ctx: FormContext = {
    draft,
    original: base.doc,
    errors: errorMap,
    showAdvanced,
    disabled: !server.writable || saving,
    onChange,
    onLocalError,
  }

  const reloadFromServer = async () => {
    const fresh = await queryClient.fetchQuery({
      queryKey: keys.settings,
      queryFn: () => api.get<SettingsResponse>('/api/settings'),
      staleTime: 0,
    })
    setBase({ revision: fresh.revision, doc: fresh.settings })
    setDraft(fresh.settings)
    setErrors([])
    setLocalErrors({})
    setNotice(null)
    setConfirming(false)
  }

  const save = async () => {
    setSaving(true)
    setNotice(null)
    try {
      const result = await api.put<SaveResponse>('/api/settings', {
        base_revision: base.revision,
        settings: draft,
        comment: comment.trim() || null,
      })
      setErrors([])
      setComment('')
      setConfirming(false)
      setNotice({
        color: 'green',
        text:
          result.diff.length === 0
            ? 'Nothing changed.'
            : `Saved as revision ${result.revision}. ${result.diff.length} ${result.diff.length === 1 ? 'setting' : 'settings'} changed and applied.`,
      })
      setBase({ revision: result.revision, doc: draft })
      void queryClient.invalidateQueries({ queryKey: keys.settings })
      void queryClient.invalidateQueries({ queryKey: keys.revisions })
      void queryClient.invalidateQueries({ queryKey: keys.status })
    } catch (err) {
      setConfirming(false)
      if (err instanceof ApiError && err.kind === 'invalid') {
        setErrors(err.errors)
        const first = err.errors[0]?.loc.split('.')[0]
        if (first && schema.properties?.[first]) setSection(first)
        setNotice({
          color: 'red',
          text: `Not saved: ${err.errors.length} ${err.errors.length === 1 ? 'value needs' : 'values need'} fixing. They are marked below.`,
        })
      } else if (err instanceof ApiError && err.kind === 'conflict') {
        setNotice({
          color: 'amber',
          text: `Not saved: someone saved revision ${err.currentRevision ?? 'newer'} meanwhile. Reload to see it; your unsaved edits here will be discarded.`,
          reload: true,
        })
      } else {
        setNotice({ color: 'red', text: `Not saved: ${(err as Error).message}` })
      }
    } finally {
      setSaving(false)
    }
  }

  const sections = Object.entries(schema.properties ?? {})
  const active = sections.find(([key]) => key === section) ?? sections[0]
  const topLevelErrors = errors.filter((e) => e.loc === '')

  return (
    <>
      {notice && (
        <div className="notice" data-color={notice.color} role="status">
          {notice.text}{' '}
          {notice.reload && (
            <button type="button" onClick={reloadFromServer}>
              Reload settings
            </button>
          )}
          {errors.length > 0 && (
            <ul>
              {errors.map((e) => (
                <li key={`${e.loc}:${e.msg}`}>
                  <button type="button" className="quiet" onClick={() => setSection(e.loc.split('.')[0] ?? section)}>
                    {e.loc || 'settings'}
                  </button>
                  {e.msg}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {changedElsewhere && dirty && !notice && (
        <div className="notice" data-color="amber" role="status">
          Revision {server.revision} was saved elsewhere while you were editing. Saving now will be refused.{' '}
          <button type="button" onClick={reloadFromServer}>
            Discard my edits and reload
          </button>
        </div>
      )}
      {topLevelErrors.map((e) => (
        <div key={e.msg} className="notice" data-color="red">
          {e.msg}
        </div>
      ))}
      <div className="settings-layout">
        <nav className="section-nav" aria-label="Settings sections">
          {sections.map(([key, node]) => {
            const info = fieldInfo(key, node)
            const sectionModified = diff.some((d) => d.path === key || d.path.startsWith(`${key}.`))
            const sectionErrors = hasErrorsUnder(errorMap, key)
            return (
              <button
                key={key}
                type="button"
                aria-current={key === active?.[0]}
                onClick={() => setSection(key)}
              >
                {info.title}
                {sectionErrors ? (
                  <Lamp color="red" label="has errors" />
                ) : sectionModified ? (
                  <Lamp color="blue" label="changed" />
                ) : null}
              </button>
            )
          })}
          <label className="toggle" style={{ padding: '12px 12px 0' }}>
            <input type="checkbox" role="switch" checked={showAdvanced} onChange={(e) => setShowAdvanced(e.target.checked)} />
            <span className="muted">Show advanced</span>
          </label>
        </nav>
        <div>
          {active && (
            <section className="panel" aria-labelledby="section-title">
              <div className="panel-head">
                <h2 id="section-title">{fieldInfo(active[0], active[1]).title}</h2>
              </div>
              <Field key={active[0]} name={active[0]} node={active[1]} path={[active[0]]} ctx={ctx} depth={0} />
            </section>
          )}
          {(dirty || confirming) && (
            <div className="save-bar">
              {confirming ? (
                <div style={{ width: '100%' }}>
                  <h3 style={{ marginBottom: 8 }}>Save these changes</h3>
                  <DiffList diff={diff} secretPaths={secretPaths} />
                  <div className="toolbar" style={{ marginTop: 12 }}>
                    <label style={{ flex: '1 1 260px' }}>
                      <span className="visually-hidden">Comment</span>
                      <input
                        type="text"
                        style={{ width: '100%' }}
                        placeholder="Comment for the history (optional)"
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                      />
                    </label>
                    <button type="button" onClick={() => setConfirming(false)}>
                      Keep editing
                    </button>
                    <button type="button" className="primary" onClick={save} disabled={saving}>
                      {saving ? 'Saving…' : 'Save and apply'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <span className="grow">
                    {diff.length} unsaved {diff.length === 1 ? 'change' : 'changes'}
                    {hasLocalErrors && <span className="field-error"> Fix the invalid JSON first.</span>}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(base.doc)
                      setErrors([])
                      setLocalErrors({})
                      setNotice(null)
                    }}
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={!server.writable || hasLocalErrors}
                    onClick={() => setConfirming(true)}
                  >
                    Review and save
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
