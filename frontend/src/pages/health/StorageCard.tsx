import { useState } from 'react'
import { Link } from 'react-router'
import { useRestoreAck, useStorageAction } from '../../api/actions'
import { useJobs, useLatestRun, useStorage } from '../../api/queries'
import type { DatabaseStorage } from '../../api/types'
import { OutcomeChip } from '../../components/Outcome'
import { ErrorNotice } from '../../components/PageHead'
import { formatBytes, formatTime } from '../../lib/format'
import { budgetColor, budgetShare, describeRemoved, describeTrimmed, tableLabel } from '../../lib/storage'

function Database({ db }: { db: DatabaseStorage }) {
  const share = budgetShare(db)
  const [open, setOpen] = useState(false)
  return (
    <div className="storage-db">
      <h3>
        {db.name} <span className="muted">{db.backed_up ? 'in Home Assistant backups' : 'not backed up, rebuilt over time'}</span>
      </h3>
      <div className="muted">
        File {formatBytes(db.file_bytes)}
        {db.wal_bytes > 0 && <> (+ {formatBytes(db.wal_bytes)} write-ahead log)</>} · data {formatBytes(db.data_bytes)} · free pages{' '}
        {formatBytes(db.free_bytes)} · budget {formatBytes(db.budget_bytes)}
      </div>
      <div className="budget-bar" data-color={budgetColor(share)} role="img" aria-label={`${Math.round(share * 100)} % of the budget`}>
        <span style={{ width: `${Math.min(100, share * 100)}%` }} />
      </div>
      {db.over_budget && (
        <div className="notice" data-color="amber">
          Over budget: the next cleanup cuts the oldest days first. Raise the budget under Settings → Storage if that is
          not wanted.
        </div>
      )}
      <button type="button" className="quiet" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide tables' : `Tables (${db.tables.length})`}
      </button>
      {open && (
        <div className="table-wrap">
          <table className="num-table">
            <thead>
              <tr>
                <th>Table</th>
                <th className="r">Rows</th>
                <th className="r">Size</th>
                <th>Oldest</th>
              </tr>
            </thead>
            <tbody>
              {db.tables.map((t) => (
                <tr key={t.name}>
                  <td>
                    {tableLabel(t.name)}
                    <div className="cell-sub">{t.name}</div>
                  </td>
                  <td className="num r">{t.rows.toLocaleString('en-US').replaceAll(',', ' ')}</td>
                  <td className="num r">{formatBytes(t.bytes)}</td>
                  <td className="num">{t.oldest ? formatTime(t.oldest) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** What the two databases hold and how full they are, with cleanup and compaction on demand. */
export function StorageCard({ writable }: { writable: boolean }) {
  const storage = useStorage()
  const jobs = useJobs()
  const cleanupRun = useLatestRun('maintenance.retention')
  const action = useStorageAction()
  const ack = useRestoreAck()
  const data = storage.data
  const running = (id: string) => jobs.data?.some((j) => j.id === id && j.running) ?? false
  const busy = action.isPending || running('maintenance.retention') || running('maintenance.compact')
  const last = data?.last_cleanup
  const backup = data?.backup
  const restored = data?.restored
  return (
    <section id="card-storage" className="panel">
      <div className="panel-head">
        <h2>Storage</h2>
        <div className="toolbar">
          <button
            type="button"
            disabled={!writable || busy}
            onClick={() => action.mutate('cleanup')}
            title="Retention, size budgets, then compaction when at least 20 % and 16 MiB are free"
          >
            {running('maintenance.retention') ? 'Cleaning up…' : 'Clean up now'}
          </button>
          <button
            type="button"
            disabled={!writable || busy}
            onClick={() => action.mutate('compact')}
            title="VACUUM both files now; needs free disk space of about their size and pauses the App briefly"
          >
            {running('maintenance.compact') ? 'Compacting…' : 'Compact now'}
          </button>
          <Link className="button" to="/settings?section=storage">
            Settings
          </Link>
        </div>
      </div>
      <div className="panel-body">
        <ErrorNotice error={storage.error ?? action.error ?? ack.error} />
        {action.data?.run_id && (
          <div className="notice">
            Started: <Link to={`/runs/${action.data.run_id}`}>run #{action.data.run_id}</Link>
          </div>
        )}
        {restored && !restored.acknowledged && (
          <div className="notice" data-color="amber">
            Restored from a backup{restored.backup_taken_at ? ` taken ${formatTime(restored.backup_taken_at)}` : ''}: run
            history up to #{restored.last_run_id} was not in it, and the agreement figures and measured history start from
            scratch.{' '}
            <button type="button" className="quiet" disabled={!writable || ack.isPending} onClick={() => ack.mutate()}>
              Dismiss
            </button>
          </div>
        )}
        {data && (
          <>
            {data.databases.map((db) => (
              <Database key={db.name} db={db} />
            ))}
            <dl className="facts">
              <div>
                <dt>Disk</dt>
                <dd>
                  {formatBytes(data.disk_free_bytes)} free of {formatBytes(data.disk_total_bytes)}
                  <div className="cell-sub">{data.data_dir}</div>
                </dd>
              </div>
              <div>
                <dt>Last cleanup</dt>
                <dd>
                  {last ? (
                    <>
                      {formatTime(last.at)} <OutcomeChip outcome={cleanupRun.data?.outcome} />
                      <div className="cell-sub">
                        Removed {describeRemoved(last.removed)}
                        {describeTrimmed(last.trimmed).length > 0 && <>; over budget, cut {describeTrimmed(last.trimmed).join('; ')}</>}
                        {Object.entries(last.vacuum)
                          .filter(([, v]) => v.ran)
                          .map(([name, v]) => (
                            <span key={name}>
                              ; compacted {name} {formatBytes(v.before_bytes)} → {formatBytes(v.after_bytes)}
                            </span>
                          ))}
                      </div>
                    </>
                  ) : (
                    'not yet (runs daily at 03:30)'
                  )}
                </dd>
              </div>
              <div>
                <dt>Newest backup with EMHASS Lens</dt>
                <dd>
                  {backup?.available ? (
                    backup.newest_at ? (
                      <>
                        {formatTime(backup.newest_at)}
                        <div className="cell-sub">
                          {backup.newest_name} ({backup.newest_type}
                          {backup.newest_size_mb !== null && backup.newest_size_mb !== undefined && <>, {backup.newest_size_mb.toFixed(0)} MB</>}
                          ) · {backup.count} backup{backup.count === 1 ? '' : 's'} include the App
                          {backup.stale && ' · older than the warning limit'}
                        </div>
                      </>
                    ) : (
                      'none: no Home Assistant backup includes the App yet'
                    )
                  ) : (
                    <span className="muted">{backup?.reason ?? 'unknown'}</span>
                  )}
                </dd>
              </div>
            </dl>
            {!data.dbstat && (
              <p className="chart-note">Sizes per table need SQLite's dbstat table, which this build lacks; row counts are shown.</p>
            )}
            <p className="chart-note">
              Cleanup keeps each database within its budget by cutting the oldest days first, never pinned runs, open problems
              or sessions, the current settings version, or the last few days the planner needs. Compaction returns free pages
              to the disk.
            </p>
          </>
        )}
      </div>
    </section>
  )
}
