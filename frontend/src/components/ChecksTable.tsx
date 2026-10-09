import type { EmhassCheck } from '../api/types'
import { statusColor } from '../lib/status'
import { LabelledLamp } from './Lamp'

const STATUS_TEXT: Record<string, string> = { ok: 'OK', info: 'Note', warning: 'Warning', error: 'Problem' }

/** EMHASS configuration checks: what EMHASS Lens relies on vs what EMHASS has. */
export function ChecksTable({ checks }: { checks: EmhassCheck[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Check</th>
            <th>Status</th>
            <th>Expected</th>
            <th>EMHASS has</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.key}>
              <td>
                <div className="cell-title">{c.title}</div>
                <div className="cell-sub" style={{ maxWidth: '60ch' }}>
                  {c.explanation}
                </div>
              </td>
              <td>
                <LabelledLamp color={statusColor(c.status)} text={STATUS_TEXT[c.status] ?? c.status} />
              </td>
              <td className="cell-sub wrap">{c.expected}</td>
              <td className="wrap">
                <code>{c.actual}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
