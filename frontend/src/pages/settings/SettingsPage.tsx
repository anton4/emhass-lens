import { useMemo, useState } from 'react'
import { useSettings, useSettingsSchema } from '../../api/queries'
import { ErrorNotice, PageHead } from '../../components/PageHead'
import { History } from './History'
import { ImportExport } from './ImportExport'
import { secretPathsOf } from '../../lib/schema'
import { SettingsForm } from './SettingsForm'

type Tab = 'edit' | 'history' | 'transfer'

export function SettingsPage() {
  const settings = useSettings()
  const schema = useSettingsSchema()
  const [tab, setTab] = useState<Tab>('edit')
  const secretPaths = useMemo(() => (schema.data ? secretPathsOf(schema.data) : []), [schema.data])

  return (
    <>
      <PageHead
        title="Settings"
        intro="Changes apply as soon as they are saved; no restart needed. Every save is kept in the history and can be reverted."
      >
        <div className="subtabs" role="group" aria-label="Settings views">
          <button type="button" aria-pressed={tab === 'edit'} onClick={() => setTab('edit')}>
            Edit
          </button>
          <button type="button" aria-pressed={tab === 'history'} onClick={() => setTab('history')}>
            History
          </button>
          <button type="button" aria-pressed={tab === 'transfer'} onClick={() => setTab('transfer')}>
            Import and export
          </button>
        </div>
      </PageHead>
      <ErrorNotice error={settings.error ?? schema.error} />
      {settings.data && schema.data && (
        <>
          {tab === 'edit' && <SettingsForm schema={schema.data} server={settings.data} />}
          {tab === 'history' && (
            <History currentRevision={settings.data.revision} writable={settings.data.writable} secretPaths={secretPaths} />
          )}
          {tab === 'transfer' && (
            <ImportExport revision={settings.data.revision} writable={settings.data.writable} secretPaths={secretPaths} />
          )}
        </>
      )}
      {(settings.isLoading || schema.isLoading) && <p className="muted">Loading settings…</p>}
    </>
  )
}
