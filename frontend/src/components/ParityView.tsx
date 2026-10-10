import type { ParityReport, ParitySection } from '../api/types'
import { formatSlot, formatTime, formatValue } from '../lib/format'
import { LabelledLamp } from './Lamp'

function SectionRow({ section }: { section: ParitySection }) {
  const ok = section.ok
  const explained = !ok && (section.explained || (section.explained_differences?.length ?? 0) > 0)
  const counted = section.compared !== undefined
  const theirs = section.theirs_label ?? 'HACS integration'
  return (
    <details className="parity-section">
      <summary>
        <LabelledLamp
          color={ok ? 'green' : section.missing ? 'neutral' : explained ? 'blue' : 'amber'}
          text={ok ? 'Same' : section.missing ? 'Not found' : explained ? 'Explained' : 'Different'}
        />
        <span className="cell-title">{section.name}</span>
        {counted && (
          <span className="muted num">
            {section.equal}/{section.compared} equal
            {section.ours_len !== section.legacy_len && ` · lengths ${section.ours_len} vs ${section.legacy_len}`}
          </span>
        )}
        {section.legacy_slots_without_ours ? (
          <span className="muted">{section.legacy_slots_without_ours} of their slots we don't have</span>
        ) : null}
        {section.skipped_forecast ? <span className="muted">{section.skipped_forecast} forecast slots not compared</span> : null}
      </summary>
      <div className="parity-body">
        {section.explained && <p className="cell-sub">{section.explained}</p>}
        {section.note && <p className="cell-sub">Likely cause: {section.note}</p>}
        {section.explained_differences?.map((text) => (
          <p key={text} className="cell-sub">
            Expected difference: {text}
          </p>
        ))}
        {(section.examples?.length ?? 0) > 0 && (
          <div className="table-wrap">
            <table className="num-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Slot</th>
                  <th className="r">EMHASS Lens</th>
                  <th className="r">{theirs}</th>
                  <th className="r">Difference</th>
                </tr>
              </thead>
              <tbody>
                {section.examples?.map((e) => (
                  <tr key={e.i}>
                    <td className="num">{e.i}</td>
                    <td className="num">{e.slot ? formatSlot(e.slot) : '—'}</td>
                    <td className="num r">{e.ours}</td>
                    <td className="num r">{e.legacy}</td>
                    <td className="num r">{e.delta}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(section.differences?.length ?? 0) > 0 && (
          <ul className="diff-list">
            {section.differences?.map((d, i) => (
              <li key={i}>
                <span className="diff-path">{String(d.key)}</span>
                <span className="diff-change">
                  {'ours' in d ? (
                    <>
                      ours {formatValue(d.ours)} · integration {formatValue(d.legacy)}
                    </>
                  ) : (
                    <>
                      {String(d.different)} values differ (lengths {formatValue(d.lengths)})
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {section.legacy_run && (
          <p className="cell-sub">
            Integration ran at {formatTime(section.legacy_run)}; our build at {formatTime(section.our_build)}
          </p>
        )}
      </div>
    </details>
  )
}

/** Comparisons with the HACS integration's entities and with the owner's price sensors, section by section. */
export function ParityView({ report }: { report: ParityReport }) {
  return (
    <div>
      {report.sections.map((section) => (
        <SectionRow key={section.name} section={section} />
      ))}
    </div>
  )
}
