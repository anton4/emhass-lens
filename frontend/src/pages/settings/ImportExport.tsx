import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError, api } from '../../api/client'
import { keys } from '../../api/queries'
import type { ImportPreview } from '../../api/types'
import { ErrorNotice } from '../../components/PageHead'
import { downloadText } from '../../lib/download'
import { DiffList } from './DiffList'

export function ImportExport({ revision, writable, secretPaths }: { revision: number; writable: boolean; secretPaths: string[] }) {
  const queryClient = useQueryClient()
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [done, setDone] = useState<string | null>(null)

  const exportYaml = async () => {
    setError(null)
    try {
      const yaml = await api.get<string>('/api/settings/export')
      downloadText(`emhass-lens-settings-r${revision}.yaml`, yaml, 'application/yaml')
    } catch (err) {
      setError(err)
    }
  }

  const run = async (dryRun: boolean) => {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const result = await api.post<ImportPreview>('/api/settings/import', {
        yaml: text,
        base_revision: revision,
        dry_run: dryRun,
        comment: null,
      })
      if (dryRun) {
        setPreview(result)
      } else {
        setPreview(null)
        if (result.errors.length > 0) {
          setPreview(result)
        } else {
          setDone(result.revision ? `Imported as revision ${result.revision}.` : 'Nothing changed.')
          setText('')
          void queryClient.invalidateQueries({ queryKey: keys.settings })
          void queryClient.invalidateQueries({ queryKey: keys.revisions })
        }
      }
    } catch (err) {
      setError(err instanceof ApiError && err.kind === 'conflict' ? new Error('Settings changed meanwhile. Preview again.') : err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Export</h2>
        </div>
        <div className="panel-body">
          <p style={{ marginTop: 0 }} className="muted">
            Download the current settings as YAML. Secrets such as API keys are masked; importing the file again keeps the
            stored ones.
          </p>
          <button type="button" onClick={exportYaml}>
            Download settings.yaml
          </button>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Import</h2>
        </div>
        <div className="panel-body">
          <p style={{ marginTop: 0 }} className="muted">
            Paste or open a settings file. Anything missing from the file goes back to its default. You see every change
            before it is applied.
          </p>
          <div className="toolbar" style={{ marginBottom: 10 }}>
            <label className="button">
              Open a file
              <input
                type="file"
                accept=".yaml,.yml,text/yaml"
                className="visually-hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  if (file) {
                    setText(await file.text())
                    setPreview(null)
                  }
                }}
              />
            </label>
          </div>
          <label>
            <span className="visually-hidden">Settings YAML</span>
            <textarea
              rows={12}
              value={text}
              placeholder="emhass:&#10;  mode: dry_run"
              onChange={(e) => {
                setText(e.target.value)
                setPreview(null)
              }}
            />
          </label>
          <div className="toolbar" style={{ marginTop: 10 }}>
            <button type="button" disabled={!text.trim() || busy} onClick={() => run(true)}>
              Preview changes
            </button>
            {preview && preview.errors.length === 0 && preview.diff.length > 0 && (
              <button type="button" className="primary" disabled={!writable || busy} onClick={() => run(false)}>
                Apply {preview.diff.length} {preview.diff.length === 1 ? 'change' : 'changes'}
              </button>
            )}
          </div>
          <ErrorNotice error={error} />
          {done && (
            <div className="notice" data-color="green" style={{ marginTop: 12 }}>
              {done}
            </div>
          )}
          {preview && preview.errors.length > 0 && (
            <div className="notice" data-color="red" style={{ marginTop: 12 }}>
              This file can't be imported:
              <ul>
                {preview.errors.map((e) => (
                  <li key={`${e.loc}:${e.msg}`}>
                    {e.loc ? <code>{e.loc}</code> : null} {e.msg}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview && preview.errors.length === 0 && (
            <div style={{ marginTop: 12 }}>
              <DiffList diff={preview.diff} secretPaths={secretPaths} />
            </div>
          )}
        </div>
      </section>
    </>
  )
}
