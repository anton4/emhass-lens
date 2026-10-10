import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router'
import { useChargeMode, useChargerDecide } from '../api/actions'
import { useCharger, useRuns, useSettings, useStatus } from '../api/queries'
import { ChargerDecisionView, ChargerRulesExplainer, SolarFacts } from '../components/ChargerViews'
import { AgreeHeadline, CompareTable } from '../components/InverterViews'
import { Lamp, LabelledLamp } from '../components/Lamp'
import { OutcomeChip } from '../components/Outcome'
import { AgreementFact } from '../components/controller/AgreementFact'
import { CompareChip } from '../components/controller/CompareChip'
import { ControllerHead } from '../components/controller/ControllerHead'
import { DayStrip } from '../components/controller/DayStrip'
import { Empty, ErrorNotice } from '../components/PageHead'
import { useNow } from '../components/useNow'
import { todayKey } from '../lib/days'
import { holdUntilNext, type StripInput } from '../lib/dayStrip'
import {
  CHARGER_FIELD_LABELS,
  chargerFieldValue,
  chargerModeSpec,
  pairCompares,
  parseChargerSummary,
  socClockText,
  type ChargerComparison,
  type ChargerLast,
  type ChargerTick,
  type SocClock,
} from '../lib/charger'
import { driftText } from '../lib/drift'
import { evReserveText } from '../lib/evReserve'
import { formatDateTime, formatTime } from '../lib/format'
import { runFilters, useListParams } from '../lib/listParams'
import { matchesSearch, nextSort, sortRows } from '../lib/sort'
import { ListControls } from '../components/ListControls'
import { SortableTh } from '../components/SortableTh'
import type { RunSummary } from '../api/types'

const MODES = [
  { id: 'off', text: 'Off' },
  { id: 'dry_run', text: 'Dry run' },
  { id: 'live', text: 'Live' },
]

/** EV charger control (experimental): what EMHASS Lens decides for the charger, and whether the Home Assistant
 * automation did the same. */
export function ChargerPage() {
  const charger = useCharger()
  const status = useStatus()
  const settings = useSettings()
  const decide = useChargerDecide()
  const chargeMode = useChargeMode()
  const navigate = useNavigate()
  const now = useNow(60_000)
  const data = charger.data
  const tz = status.data?.timezone
  const drift = driftText(data?.drift, now, tz)
  const writable = status.data?.writable ?? false
  const last = (data?.last ?? null) as ChargerLast | null
  const lastCompare = (data?.last_compare ?? null) as ChargerComparison | null
  const tick = (data?.last_tick ?? null) as ChargerTick | null
  const soc = data?.soc as SocClock | undefined
  const limits = settings.data?.settings.charger.limits

  const today = todayKey(tz, now)
  const todayDecides = useRuns(runFilters('charger.decide', today, tz, 0))
  const todayCompares = useRuns(runFilters('charger.compare', today, tz, 0))
  const strip = useMemo<StripInput[]>(
    () =>
      holdUntilNext(
        pairCompares(todayDecides.data ?? [], todayCompares.data ?? []).map((row) => ({
          t: Date.parse(row.at) / 1000,
          compare: row.compare?.outcome,
          label: parseChargerSummary(row.decide?.summary)?.rule,
          runId: row.decide?.id ?? row.compare?.id,
        })),
        900,
      ),
    [todayDecides.data, todayCompares.data],
  )

  return (
    <>
      <ControllerHead
        title="EV charger"
        section="charger"
        mode={data?.mode}
        modes={MODES}
        spec={chargerModeSpec}
        automation="EV Charging: Combined EMHASS & Excess Solar"
        liveNotice={
          <>
            <strong>EMHASS Lens controls the charger.</strong> Make sure the automation "EV Charging: Combined EMHASS
            &amp; Excess Solar" is off, or both will write.
          </>
        }
        writable={writable}
        actions={
          <>
            {data?.charge_mode && <span className="toolbar-label">Charge mode</span>}
            {data?.charge_mode && (
              <div
                className="segmented"
                role="group"
                aria-label="Charge mode"
                title={
                  data.charge_mode.current
                    ? `${data.charge_mode.entity}: the Home Assistant helper your automation reads too`
                    : 'The charge mode helper has no state yet'
                }
              >
                {data.charge_mode.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={option === data.charge_mode?.current}
                    disabled={!writable || chargeMode.isPending || !data.charge_mode?.current}
                    onClick={() => chargeMode.mutate(option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              className="primary"
              disabled={!writable || decide.isPending}
              onClick={() =>
                decide.mutate(undefined, {
                  onSuccess: (started) => started.run_id && navigate(`/runs/${started.run_id}`),
                })
              }
              title={data?.mode === 'live' ? 'Decides and applies now' : 'Decides now without touching the charger'}
            >
              {decide.isPending ? 'Deciding…' : 'Decide now'}
            </button>
            <Link className="button" to="/settings?section=charger">
              Settings
            </Link>
          </>
        }
      >
        <div>
          <dt>In control</dt>
          <dd>
            {!data || data.mode !== 'live' ? (
              <span className="faint">—</span>
            ) : data.preconditions ? (
              <LabelledLamp color="amber" text="Not now" />
            ) : (
              <LabelledLamp color="green" text="EMHASS Lens is in control" />
            )}
            {data?.preconditions && <div className="cell-sub">{data.preconditions}</div>}
          </dd>
        </div>
        <AgreementFact title="Agreement, 24 h" agreement={data?.agreement_24h} per="decision" />
        <AgreementFact title="Agreement, 7 days" agreement={data?.agreement_7d} per="decision" />
        <div>
          <dt>Kept in sync</dt>
          <dd>
            <LabelledLamp color={drift.color} text={drift.text} />
            {drift.detail && <div className="cell-sub">{drift.detail}</div>}
          </dd>
        </div>
        <div>
          <dt>Target SoC clock</dt>
          <dd>{socClockText(soc, tz)}</dd>
        </div>
        <div>
          <dt>PV reserved for the car</dt>
          <dd>
            {data?.pv_reserve ? evReserveText(data.pv_reserve, tz) : <span className="faint">off</span>}
            <div className="cell-sub">
              {data?.pv_reserve
                ? 'While the car charges from excess solar, its share is taken out of the PV forecast EMHASS plans with.'
                : 'Settings → EV charger control → PV reserved for Excess Solar keeps the car’s share out of the PV forecast EMHASS plans with.'}
            </div>
          </dd>
        </div>
      </ControllerHead>
      <ErrorNotice error={charger.error ?? decide.error ?? chargeMode.error} />

      <DayStrip
        inputs={strip}
        span={900}
        timeZone={tz}
        what="decision"
        empty={
          data?.mode === 'off'
            ? 'EV charger control is off, so nothing is decided. Switch to Dry run to compare with the automation.'
            : 'No decisions yet today.'
        }
      />

      <div className="two-col">
        <section className="panel">
          <div className="panel-head">
            <h2>Last decision</h2>
            {last && (
              <span className="muted">
                {formatTime(last.at, new Date(), tz)} · {last.trigger.replace('_', ' ')} ·{' '}
                <Link to={`/runs/${last.run_id}`}>run {last.run_id}</Link>
              </span>
            )}
          </div>
          <div className="panel-body">
            {!last ? (
              <Empty title="No decision yet">
                {data?.mode === 'off'
                  ? 'EV charger control is off. Use Decide now to see what it would do.'
                  : 'The next decision comes with the next publish, minute check or SoC stop.'}
              </Empty>
            ) : (
              <>
                {last.blocked && (
                  <div className="notice" data-color="amber" role="note">
                    Not in control: {last.blocked}. This is what it would have done.
                  </div>
                )}
                <ChargerDecisionView decision={last.decision} inputs={last.inputs} />
                <p className="cell-sub" style={{ marginBottom: 0 }}>
                  EV power from {last.source}.
                </p>
              </>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Last comparison</h2>
            {lastCompare?.decision_run_id !== undefined && (
              <span className="muted">
                <Link to={`/runs/${lastCompare.decision_run_id}`}>decision run {lastCompare.decision_run_id}</Link>
              </span>
            )}
          </div>
          <div className="panel-body">
            {!lastCompare ? (
              <Empty title="Nothing compared yet">
                In dry run, each decision is compared a few seconds later with what the Home Assistant automation did to
                the charger.
              </Empty>
            ) : lastCompare.unexpected ? (
              <>
                <p style={{ marginTop: 0 }}>
                  <LabelledLamp color="amber" text="The automation acted on its own" />
                </p>
                <p className="cell-sub">
                  It set the current limit from {lastCompare.unexpected.from} A to {lastCompare.unexpected.to} A at{' '}
                  {formatTime(lastCompare.unexpected.at, new Date(), tz)} while EMHASS Lens had decided nothing.
                </p>
              </>
            ) : (
              <>
                <p style={{ marginTop: 0 }}>
                  <AgreeHeadline comparison={lastCompare} what="Automation vs EMHASS Lens" />
                </p>
                <CompareTable comparison={lastCompare} labels={CHARGER_FIELD_LABELS} format={chargerFieldValue} />
                {lastCompare.charging_state !== undefined && (
                  <p className="cell-sub">
                    Charger afterwards: {chargerFieldValue('state_raw', lastCompare.charging_state)}.
                  </p>
                )}
              </>
            )}
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Excess solar now</h2>
          {tick && <span className="muted">checked {formatTime(tick.at, new Date(), tz)}</span>}
        </div>
        <div className="panel-body">
          {!tick ? (
            <Empty title="No minute check yet" />
          ) : (
            <>
              <dl className="event-values">
                <SolarFacts derived={tick.derived} />
                <div>
                  <dt>Conclusion</dt>
                  <dd>{tick.rule === 'none' ? 'nothing to do' : tick.rule}</dd>
                  <div className="cell-sub">{tick.why}</div>
                </div>
              </dl>
            </>
          )}
        </div>
      </section>

      <ChargerRulesExplainer limits={limits} current={last?.decision.rule} />

      <ChargerHistory timeZone={tz} />
    </>
  )
}

/** Recent decisions: what was decided and whether the automation did the same. */
function ChargerHistory({ timeZone }: { timeZone?: string }) {
  const [list, setList] = useListParams('d.', { key: 'at', dir: 'desc' })
  const decides = useRuns(runFilters('charger.decide', list.day, timeZone, 48))
  const compares = useRuns(runFilters('charger.compare', list.day, timeZone, 48))
  const all = pairCompares(decides.data ?? [], compares.data ?? []).map((row) => ({
    row,
    parsed: parseChargerSummary(row.decide?.summary),
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
      list.sort.key === 'branch'
        ? parsed?.rule
        : list.sort.key === 'automation'
          ? row.compare?.outcome
          : Date.parse(row.at),
    list.sort.dir,
  )
  const onSort = (key: string) => setList({ sort: nextSort(list.sort, key, key === 'at' ? 'desc' : 'asc') })
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Recent decisions</h2>
        <span className="muted">{list.day ? `All of ${list.day}` : 'The latest decisions and comparisons'}</span>
      </div>
      <div className="panel-body">
        <ListControls
          value={list}
          onChange={setList}
          timeZone={timeZone}
          filterLabel="Branches"
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
                <SortableTh label="When" sortKey="at" sort={list.sort} onSort={onSort} />
                <th>Decision</th>
                <SortableTh label="Branch" sortKey="branch" sort={list.sort} onSort={onSort} />
                <SortableTh label="Automation" sortKey="automation" sort={list.sort} onSort={onSort} />
              </tr>
            </thead>
            <tbody>
              {shown.map(({ row, parsed }) => (
                <tr key={`${row.decide?.id ?? 'c'}-${row.compare?.id ?? 'd'}`}>
                  <td className="num">{formatDateTime(row.at, timeZone)}</td>
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
                        {parsed.action && parsed.rule !== 'none' && <strong> → {parsed.action}</strong>}
                        {parsed.rule === 'none' && parsed.action && <span className="muted">: {parsed.action}</span>}
                        {parsed.facts && <div className="cell-sub">{parsed.facts}</div>}
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
                      <div className="cell-sub">{row.compare.summary.replace(/^Decision #\d+: differs — /, '')}</div>
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

function DecideChip({ run }: { run: RunSummary }) {
  if (run.outcome === 'noop' && run.summary?.startsWith('Not in control')) {
    return (
      <span className="chip" data-color="amber">
        <Lamp color="amber" />
        Not in control
      </span>
    )
  }
  return <OutcomeChip outcome={run.outcome} />
}
