import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useInverterDecide } from '../api/actions'
import {
  useInverter,
  useInverterActivity,
  useInverterAhead,
  useMarketSessions,
  useRuns,
  useSettings,
  useStatus,
} from '../api/queries'
import { AgreeHeadline, CompareTable, DecisionView, RulesExplainer } from '../components/InverterViews'
import { Lamp, LabelledLamp } from '../components/Lamp'
import { OutcomeChip } from '../components/Outcome'
import { AgreementFact } from '../components/controller/AgreementFact'
import { CompareChip } from '../components/controller/CompareChip'
import { ControllerHead } from '../components/controller/ControllerHead'
import { DayChips } from '../components/controller/DayChips'
import { DayStrip } from '../components/controller/DayStrip'
import { StripKey } from '../components/controller/StripKey'
import { InverterSlotPopup } from '../components/controller/InverterSlotPopup'
import { useStripDay } from '../components/controller/useStripDay'
import { WearFacts } from '../components/controller/WearFacts'
import { Empty, ErrorNotice } from '../components/PageHead'
import { useNow } from '../components/useNow'
import type { StripItem } from '../lib/dayStrip'
import { dayBounds, shiftDay, todayKey } from '../lib/days'
import { driftText } from '../lib/drift'
import { formatDateTime, formatSlotDate } from '../lib/format'
import { runFilters, useListParams } from '../lib/listParams'
import {
  PRESS_COLOR,
  pressButton,
  pressColor,
  pressCounts,
  pressedOutside,
  pressesInSlot,
  pressTicks,
  pressWho,
} from '../lib/presses'
import { matchesSearch, nextSort, sortRows } from '../lib/sort'
import { ListControls } from '../components/ListControls'
import { SortableTh } from '../components/SortableTh'
import {
  FIELD_LABELS,
  inverterModeSpec,
  decideChip,
  inverterLegend,
  inverterAhead,
  inverterStrip,
  inverterTicks,
  mergeBySlot,
  parseDecisionSummary,
  type InverterComparison,
  type InverterLast,
  type SlotDetail,
} from '../lib/inverter'
import type { ButtonPress, RunSummary } from '../api/types'

/** What the automation set differently in a slot, for the Automation row's popup. */
function slotDiffers(item: StripItem<SlotDetail>): string | null {
  const fields = Object.entries(item.detail?.differs ?? {})
  if (fields.length === 0) return null
  return fields.map(([field, value]) => `${FIELD_LABELS[field] ?? field}: the automation set ${value}`).join('; ')
}

const MODES = [
  { id: 'off', text: 'Off' },
  { id: 'dry_run', text: 'Dry run' },
  { id: 'live', text: 'Live' },
]

/** Inverter control (experimental): what EMHASS Lens decides for the Sofar inverter each slot, and whether the
 * Home Assistant automation did the same. */
export function InverterPage() {
  const inverter = useInverter()
  const status = useStatus()
  const settings = useSettings()
  const decide = useInverterDecide()
  const navigate = useNavigate()
  const now = useNow(60_000)
  const data = inverter.data
  const tz = status.data?.timezone
  const drift = driftText(data?.drift, now, tz)
  const writable = status.data?.writable ?? false
  const last = (data?.last ?? null) as InverterLast | null
  const lastCompare = (data?.last_compare ?? null) as InverterComparison | null
  const limits = settings.data?.settings.inverter.limits

  // the planned modes after the slot in force; tomorrow can be shown once the plan reaches it
  const aheadQuery = useInverterAhead()
  const planned = useMemo(() => inverterAhead(aheadQuery.data), [aheadQuery.data])
  const tomorrow = Date.parse(dayBounds(shiftDay(todayKey(tz, now), 1), tz).since) / 1000
  const reachesTomorrow = planned.some((p) => p.t >= tomorrow)
  // the strip's day: today, one up to a week back, or tomorrow (?day=)
  const { day, days, today, setDay } = useStripDay(tz, now, reachesTomorrow ? 1 : 0)
  const dayDecides = useRuns(runFilters('inverter.decide', day, tz, 0))
  const dayCompares = useRuns(runFilters('inverter.compare', day, tz, 0))
  const bounds = dayBounds(day, tz)
  const activity = useInverterActivity(bounds)
  const presses = activity.data?.presses
  const writes = activity.data?.writes
  // the market's own sessions: one started the day before can still hold the inverter
  const sessionsSince = new Date(Date.parse(bounds.since) - 86_400_000).toISOString()
  const sessions = useMarketSessions({ since: sessionsSince, until: bounds.until })
  const strip = useMemo(
    () =>
      inverterStrip(
        mergeBySlot(dayDecides.data ?? [], dayCompares.data ?? []),
        sessions.data ?? [],
        writes ?? [],
        now.getTime(),
      ).map((input) =>
        input.detail
          ? { ...input, detail: { ...input.detail, presses: pressesInSlot(presses ?? [], input.detail.slot) } }
          : input,
      ),
    [dayDecides.data, dayCompares.data, sessions.data, writes, presses, now],
  )
  const writeTicks = useMemo(() => inverterTicks(strip), [strip])
  // a day to come is all plan: its key counts the planned slots
  const [dayFrom, dayUntil] = [Date.parse(bounds.since) / 1000, Date.parse(bounds.until) / 1000]
  const plannedOfDay = planned.filter((p) => p.t >= dayFrom && p.t < dayUntil)
  // EMHASS Lens's own presses are its writes, on the row of their own; a press from outside stands out on the marks
  const ticks = useMemo(() => pressTicks((presses ?? []).filter(pressedOutside)), [presses])
  const pressesOfDay = pressCounts(presses ?? [], bounds.since, bounds.until)

  return (
    <>
      <ControllerHead
        title="Inverter"
        section="inverter"
        mode={data?.mode}
        modes={MODES}
        spec={inverterModeSpec}
        automation="EMHASS: Consolidated Inverter Control"
        liveNotice={
          <>
            <strong>EMHASS Lens controls the inverter.</strong> Make sure the automation "EMHASS: Consolidated Inverter
            Control" is off, or both will write to the inverter.
          </>
        }
        writable={writable}
        actions={
          <>
            <button
              type="button"
              className="primary"
              disabled={!writable || decide.isPending}
              onClick={() =>
                decide.mutate(undefined, {
                  onSuccess: (started) => started.run_id && navigate(`/runs/${started.run_id}`),
                })
              }
              title={
                data?.mode === 'live'
                  ? 'Decides and applies for the current slot'
                  : 'Decides for the current slot without touching the inverter'
              }
            >
              {decide.isPending ? 'Deciding…' : 'Decide now'}
            </button>
            <Link
              className="button"
              to="/runs?wrote=inverter"
              title="Every run that wrote to the inverter: the plan's and the market sessions'"
            >
              Inverter writes
            </Link>
            <Link className="button" to="/settings?section=inverter">
              Settings
            </Link>
          </>
        }
      >
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
        <AgreementFact title="Agreement, 24 h" agreement={data?.agreement_24h} />
        <AgreementFact title="Agreement, 7 days" agreement={data?.agreement_7d} />
        <div>
          <dt>Kept in sync</dt>
          <dd>
            <LabelledLamp color={drift.color} text={drift.text} />
            {drift.detail && <div className="cell-sub">{drift.detail}</div>}
          </dd>
        </div>
        <WearFacts day={data?.wear_24h} week={data?.wear_7d} />
      </ControllerHead>
      <ErrorNotice error={inverter.error ?? decide.error} />

      <DayStrip
        day={day}
        chips={<DayChips day={day} days={days} today={today} onChange={setDay} />}
        inputs={strip}
        span={900}
        timeZone={tz}
        rowLabel="Mode"
        subtitle="Sofar mode per slot, market sessions striped"
        empty={
          day !== today
            ? 'No decisions that day.'
            : data?.mode === 'off'
              ? 'Nothing decided: inverter control is off.'
              : 'No decisions yet today.'
        }
        legend={
          <StripKey items={inverterLegend(day > today ? plannedOfDay : strip)}>
            <PressKey presses={pressesOfDay} />
          </StripKey>
        }
        detail={(item) => item.detail && <InverterSlotPopup detail={item.detail} timeZone={tz} />}
        differText={slotDiffers}
        writes={{ ticks: writeTicks, target: 'inverter', held: 'held: not in control' }}
        ahead={data?.mode === 'off' ? undefined : planned}
        ticks={ticks}
      />

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
                  ? 'Decide now shows what it would do.'
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
                    ·{' '}
                    <Link to={`/runs/${lastCompare.decision_run_id}`}>decision run {lastCompare.decision_run_id}</Link>
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

      <RulesExplainer
        limits={limits}
        noExportAtOrBelow={settings.data?.settings.emhass.mpc.no_export_at_or_below ?? null}
        current={last?.decision.branch ?? last?.decision.rule}
      />

      <InverterHistory timeZone={tz} />
      <PressHistory presses={data?.presses} timeZone={tz} />
    </>
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
                <SortableTh label="Slot" sortKey="slot" sort={list.sort} onSort={onSort} title={`Times in ${timeZone ?? "your browser's timezone"}`} />
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
    </section>
  )
}

/** The strip key's button presses from outside EMHASS Lens, where there were any (its own are on the writes row). */
function PressKey({ presses }: { presses: { outside: number } }) {
  if (presses.outside === 0) return null
  return (
    <span className="day-strip-key-item">
      <span className="day-strip-swatch dot" style={{ background: PRESS_COLOR.outside }} />
      Pressed outside EMHASS Lens <span className="num">{presses.outside}</span>
    </span>
  )
}

/** Every press of the Sofar apply and feed-in buttons in the last 7 days: ours (with the run) and anyone else's. */
function PressHistory({ presses, timeZone }: { presses: ButtonPress[] | undefined; timeZone?: string }) {
  const [outsideOnly, setOutsideOnly] = useState(false)
  const all = presses ?? []
  const outside = all.filter(pressedOutside)
  const shown = outsideOnly ? outside : all
  return (
    <section className="panel">
      <div className="panel-head">
        <h2 title="Every press writes the inverter's EEPROM. Who pressed comes from Home Assistant: an automation, or a user in the UI or through a script. Presses while EMHASS Lens wasn't running aren't counted.">
          Button presses
        </h2>
        <span className="muted">The last 7 days{all.length >= 200 ? ', the latest 200' : ''}</span>
      </div>
      <div className="panel-body">
        <div className="toolbar list-controls">
          <label className="check">
            <input type="checkbox" checked={outsideOnly} onChange={(e) => setOutsideOnly(e.target.checked)} />
            Only outside EMHASS Lens
          </label>
        </div>
      </div>
      {shown.length === 0 ? (
        <div className="panel-body">
          <Empty title={all.length === 0 ? 'No presses seen in the last 7 days' : 'None outside EMHASS Lens'}>
            {all.length === 0
              ? 'A press of the apply or feed-in button shows up here, whoever pressed it.'
              : 'Every press in the last 7 days was made by EMHASS Lens.'}
          </Empty>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th title={`Times in ${timeZone ?? "your browser's timezone"}`}>Time</th>
                <th>Button</th>
                <th>Pressed by</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p, i) => (
                <tr key={`${p.at}-${p.entity_id}-${i}`}>
                  <td className="num">{formatDateTime(p.at, timeZone)}</td>
                  <td>{pressButton(p)}</td>
                  <td>
                    <span className="press-who">
                      <span className="day-strip-swatch dot" style={{ background: pressColor(p) }} />
                      {p.run_id ? (
                        <Link to={`/runs/${p.run_id}`}>
                          {pressWho(p, true)}, run {p.run_id}
                        </Link>
                      ) : (
                        pressWho(p, true)
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
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
