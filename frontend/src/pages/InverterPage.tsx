import { Link, useNavigate } from 'react-router'
import { useInverterDecide } from '../api/actions'
import { useInverter, useRuns, useSettings, useStatus } from '../api/queries'
import { AgreeHeadline, CompareTable, DecisionView, RulesExplainer } from '../components/InverterViews'
import { Lamp, LabelledLamp } from '../components/Lamp'
import { OutcomeChip } from '../components/Outcome'
import { Empty, ErrorNotice, PageHead } from '../components/PageHead'
import { driftText } from '../lib/drift'
import { formatSlotDate } from '../lib/format'
import { runFilters, useListParams } from '../lib/listParams'
import { matchesSearch, nextSort, sortRows } from '../lib/sort'
import { ListControls } from '../components/ListControls'
import { SortableTh } from '../components/SortableTh'
import {
  formatAgreement,
  inverterModeSpec,
  decideChip,
  mergeBySlot,
  parseDecisionSummary,
  type InverterComparison,
  type InverterLast,
} from '../lib/inverter'
import type { Agreement, RunSummary } from '../api/types'

/** Inverter control (experimental): what EMHASS Lens decides for the Sofar inverter each slot, and whether the
 * Home Assistant automation did the same. */
export function InverterPage() {
  const inverter = useInverter()
  const status = useStatus()
  const settings = useSettings()
  const decide = useInverterDecide()
  const navigate = useNavigate()
  const data = inverter.data
  const tz = status.data?.timezone
  const drift = driftText(data?.drift, new Date(), tz)
  const writable = status.data?.writable ?? false
  const mode = inverterModeSpec(data?.mode)
  const last = (data?.last ?? null) as InverterLast | null
  const lastCompare = (data?.last_compare ?? null) as InverterComparison | null
  const limits = settings.data?.settings.inverter.limits

  return (
    <>
      <PageHead
        title="Inverter"
        intro={
          <>
            Experimental. What EMHASS Lens would set on the Sofar inverter for each slot, and how often that matches what your
            Home Assistant automation does. Agreement is the number to watch before letting EMHASS Lens drive the inverter.
          </>
        }
      >
        <div className="action-row" style={{ margin: 0 }}>
          <button
            type="button"
            className="primary"
            disabled={!writable || decide.isPending}
            onClick={() =>
              decide.mutate(undefined, { onSuccess: (started) => started.run_id && navigate(`/runs/${started.run_id}`) })
            }
            title={data?.mode === 'live' ? 'Decides and applies for the current slot' : 'Decides for the current slot without touching the inverter'}
          >
            {decide.isPending ? 'Deciding…' : 'Decide now'}
          </button>
          <Link className="button" to="/settings?section=inverter">
            Settings
          </Link>
        </div>
      </PageHead>
      <ErrorNotice error={inverter.error ?? decide.error} />

      <section className="panel">
        <div className="panel-head">
          <h2>Status</h2>
          <LabelledLamp color={mode.color} text={mode.text} />
        </div>
        <div className="panel-body">
          <p style={{ marginTop: 0 }}>
            {mode.explain} Change the mode under <Link to="/settings?section=inverter">Settings → Inverter control</Link>
            {data?.mode !== 'live' && '; Live needs the Home Assistant automation turned off first'}.
          </p>
          {data?.mode === 'live' && (
            <div className="notice" data-color="amber" role="note">
              <strong>EMHASS Lens controls the inverter.</strong> Make sure the automation "EMHASS: Consolidated Inverter
              Control" is off, or both will write to the inverter.
            </div>
          )}
          <dl className="facts">
            <div>
              <dt>In control</dt>
              <dd>
                {!data || data.mode === 'off' ? (
                  <span className="faint">—</span>
                ) : data.preconditions ? (
                  <LabelledLamp color="amber" text="Not now" />
                ) : (
                  <LabelledLamp color="green" text="EMHASS Lens is in control" />
                )}
                {data?.preconditions && <div className="cell-sub">{data.preconditions}</div>}
              </dd>
            </div>
            <div>
              <dt>Kept in sync</dt>
              <dd>
                <LabelledLamp color={drift.color} text={drift.text} />
                {drift.detail && <div className="cell-sub">{drift.detail}</div>}
              </dd>
            </div>
            <AgreementFact title="Agreement, 24 h" agreement={data?.agreement_24h} />
            <AgreementFact title="Agreement, 7 days" agreement={data?.agreement_7d} />
          </dl>
        </div>
      </section>

      <div className="two-col">
        <section className="panel">
          <div className="panel-head">
            <h2>This slot</h2>
            {last && (
              <span className="muted">
                slot {formatSlotDate(last.slot, tz)} · <Link to={`/runs/${last.run_id}`}>run {last.run_id}</Link>
              </span>
            )}
          </div>
          <div className="panel-body">
            {!last ? (
              <Empty title="No decision yet">
                {data?.mode === 'off'
                  ? 'Inverter control is off. Use Decide now to see what it would do for the current slot.'
                  : 'The next decision comes right after the next slot starts.'}
              </Empty>
            ) : (
              <>
                {last.blocked && (
                  <div className="notice" data-color="amber" role="note">
                    Not in control: {last.blocked}. This is what it would have set.
                  </div>
                )}
                <DecisionView decision={last.decision} />
                <p className="cell-sub" style={{ marginBottom: 0 }}>
                  From {last.source}.
                </p>
              </>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Last comparison</h2>
            {lastCompare && (
              <span className="muted">
                slot {formatSlotDate(lastCompare.slot, tz)}
                {lastCompare.decision_run_id !== undefined && (
                  <>
                    {' '}
                    · <Link to={`/runs/${lastCompare.decision_run_id}`}>decision run {lastCompare.decision_run_id}</Link>
                  </>
                )}
              </span>
            )}
          </div>
          <div className="panel-body">
            {!lastCompare ? (
              <Empty title="Nothing compared yet">
                In dry run, each slot's decision is compared at mm:00:45 with what the Home Assistant automation set.
              </Empty>
            ) : (
              <>
                <p style={{ marginTop: 0 }}>
                  <AgreeHeadline comparison={lastCompare} what="Automation vs EMHASS Lens" />
                </p>
                <CompareTable comparison={lastCompare} />
              </>
            )}
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-body">
          <RulesExplainer limits={limits} />
        </div>
      </section>

      <InverterHistory timeZone={tz} />
    </>
  )
}

function AgreementFact({ title, agreement }: { title: string; agreement: Agreement | undefined }) {
  const a = formatAgreement(agreement)
  return (
    <div>
      <dt>{title}</dt>
      <dd>
        <span className="readout agreement-value">{a.percent}</span>
        <div className="cell-sub">
          {agreement && agreement.compared > 0 ? <LabelledLamp color={a.color} text={a.text} /> : a.text}
        </div>
      </dd>
    </div>
  )
}

/** Recent slots: what was decided and whether the automation did the same. */
function InverterHistory({ timeZone }: { timeZone?: string }) {
  const [list, setList] = useListParams('s.', { key: 'slot', dir: 'desc' })
  const decides = useRuns(runFilters('inverter.decide', list.day, timeZone, 48))
  const compares = useRuns(runFilters('inverter.compare', list.day, timeZone, 48))
  const all = mergeBySlot(decides.data ?? [], compares.data ?? []).map((row) => ({
    row,
    parsed: parseDecisionSummary(row.decide?.summary),
  }))
  const rules = [...new Set(all.map((r) => r.parsed?.rule).filter((r): r is string => Boolean(r)))].sort()
  const shown = sortRows(
    all.filter(
      ({ row, parsed }) =>
        (!list.filter || parsed?.rule === list.filter) &&
        (!list.mismatch || row.compare?.outcome === 'mismatch') &&
        matchesSearch([row.decide?.summary, row.compare?.summary, parsed?.label], list.q),
    ),
    ({ row, parsed }) =>
      list.sort.key === 'rule' ? parsed?.rule : list.sort.key === 'automation' ? row.compare?.outcome : row.slot,
    list.sort.dir,
  )
  const onSort = (key: string) => setList({ sort: nextSort(list.sort, key, key === 'slot' ? 'desc' : 'asc') })
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Recent slots</h2>
        <span className="muted">{list.day ? `All of ${list.day}` : 'The latest decisions and comparisons'}</span>
      </div>
      <div className="panel-body">
        <ListControls
          value={list}
          onChange={setList}
          timeZone={timeZone}
          filterLabel="Rules"
          filterOptions={rules.map((r) => ({ value: r, label: r }))}
          mismatchLabel="Only where the automation differed"
          shown={`${shown.length} of ${all.length}`}
        />
        <ErrorNotice error={decides.error ?? compares.error} />
      </div>
      {shown.length === 0 ? (
        <div className="panel-body">
          <Empty title={all.length === 0 ? 'No decisions recorded for this choice' : 'Nothing matches the filters'} />
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortableTh label="Slot" sortKey="slot" sort={list.sort} onSort={onSort} />
                <th>Decision</th>
                <SortableTh label="Rule" sortKey="rule" sort={list.sort} onSort={onSort} />
                <SortableTh label="Automation" sortKey="automation" sort={list.sort} onSort={onSort} />
              </tr>
            </thead>
            <tbody>
              {shown.map(({ row, parsed }) => (
                <tr key={row.slot}>
                  <td className="num">{formatSlotDate(new Date(row.slot).toISOString(), timeZone)}</td>
                  <td>
                    {row.decide ? (
                      <Link to={`/runs/${row.decide.id}`}>
                        <DecideChip run={row.decide} />
                      </Link>
                    ) : (
                      <span className="faint">—</span>
                    )}
                    {row.decide && !parsed && row.decide.summary && <div className="cell-sub">{row.decide.summary}</div>}
                  </td>
                  <td>
                    {parsed ? (
                      <>
                        <span className="rule-badge small word">{parsed.rule === 'none' ? '–' : parsed.rule}</span> {parsed.label}
                      </>
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                  <td>
                    {row.compare ? (
                      <Link to={`/runs/${row.compare.id}`} title={row.compare.summary ?? undefined}>
                        <CompareChip outcome={row.compare.outcome} />
                      </Link>
                    ) : (
                      <span className="faint">—</span>
                    )}
                    {row.compare?.outcome === 'mismatch' && row.compare.summary && (
                      <div className="cell-sub">{row.compare.summary.replace(/^Differs — /, '')}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="panel-body cell-sub">Times in {timeZone ?? "your browser's timezone"}.</div>
    </section>
  )
}

/** The automation-comparison outcome of a slot, in words. */
function CompareChip({ outcome }: { outcome: string }) {
  if (outcome === 'ok' || outcome === 'mismatch') {
    const same = outcome === 'ok'
    return (
      <span className="chip" data-color={same ? 'green' : 'amber'}>
        <Lamp color={same ? 'green' : 'amber'} />
        {same ? 'Same' : 'Differs'}
      </span>
    )
  }
  return <OutcomeChip outcome={outcome} />
}

function DecideChip({ run }: { run: RunSummary }) {
  const special = decideChip(run)
  if (!special) return <OutcomeChip outcome={run.outcome} />
  return (
    <span className="chip" data-color={special.color === 'neutral' ? undefined : special.color}>
      <Lamp color={special.color} />
      {special.text}
    </span>
  )
}
