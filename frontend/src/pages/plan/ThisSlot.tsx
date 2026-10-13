import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import type { ChargerNow, InverterNow, NowQuantity, PlanPrice, PlanRow } from '../../api/types'
import { LabelledLamp, Lamp } from '../../components/Lamp'
import { useNow } from '../../components/useNow'
import { modeTone } from '../../lib/inverter'
import { formatClock } from '../../lib/format'
import { deferrableColumns, num, socOf } from '../../lib/plan'
import { expectedText, inverterParts, type NowByKey } from '../../lib/planNow'
import {
  agreement,
  flowHeadline,
  flowNodes,
  flowSegments,
  measuredValues,
  NARROW_FLOW,
  planValues,
  priceInDay,
  segmentBox,
  shortAge,
  WIDE_FLOW,
  type FlowLayout,
  type FlowNode,
} from '../../lib/slotFlow'
import { formatFraction, formatPrice, isNumber } from '../../lib/units'

/** How old a sensor's value is now, and its hover text. A slot that has ended shows quarter-hour means instead. */
function sensorAge(
  q: NowQuantity | undefined,
  past: boolean,
  fetchedAt: number,
  now: Date,
  tz: string,
): { age: string | null; title: string | undefined } {
  if (!q?.entity) return { age: null, title: undefined }
  const expected = expectedText(q, past)
  const prefix = expected ? `${expected} · ` : ''
  if (past) return { age: null, title: `${prefix}quarter-hour mean of ${q.entity}` }
  if (!isNumber(q.age_s)) return { age: null, title: `${prefix}${q.entity}` }
  const changed = fetchedAt - q.age_s * 1000
  const age = shortAge((now.getTime() - changed) / 1000)
  return { age, title: `${prefix}${q.entity} last changed at ${formatClock(new Date(changed).toISOString(), tz)}` }
}

function FlowBox({
  node,
  layout,
  narrow,
  withDeferrable,
  q,
  socQ,
  past,
  fetchedAt,
  now,
  tz,
}: {
  node: FlowNode
  layout: FlowLayout
  /** No room beside the big number: the state of charge goes at the end of the direction line. */
  narrow: boolean
  withDeferrable: boolean
  q: NowQuantity | undefined
  /** The battery's state-of-charge sensor, for the hover text. */
  socQ?: NowQuantity
  past: boolean
  fetchedAt: number
  now: Date
  tz: string
}) {
  const at = node.key === 'load' && !withDeferrable ? layout.at.loadAlone : layout.at[node.key]
  const differs = node.measured ? q?.differs : null
  const { age, title } = sensorAge(q, past, fetchedAt, now, tz)
  const socSensor = node.soc?.measured && socQ?.entity ? sensorAge(socQ, past, fetchedAt, now, tz).title : undefined
  const soc = node.soc && (
    <span
      className="flow-node-soc"
      data-differs={node.soc.differs || undefined}
      title={socSensor ? `${node.soc.note} · ${socSensor}` : node.soc.note}
    >
      <span className="visually-hidden">state of charge </span>
      {node.soc.text}
    </span>
  )
  return (
    <div
      className="flow-node"
      data-differs={differs || undefined}
      data-expected={node.expected ? true : undefined}
      data-idle={node.idle || undefined}
      // a box with an expected line may grow into the room above the house and EV boxes rather than cut it off
      style={{ left: at.x, top: at.y, width: layout.node.w, [node.expected ? 'minHeight' : 'height']: layout.node.h }}
    >
      <div className="flow-node-head">
        <span className="flow-node-name">
          <span className="swatch" style={{ background: `var(${node.quantity})` }} aria-hidden="true" />
          {node.label}
        </span>
        {age && (
          <span className="flow-node-age" title={title}>
            {age}
          </span>
        )}
        {typeof differs === 'boolean' && (
          <Lamp color={differs ? 'amber' : 'green'} label={differs ? 'differs from what is expected' : 'as expected'} />
        )}
      </div>
      <div className="flow-node-row">
        <span className="flow-node-value" title={title}>
          {node.value ?? '—'}
        </span>
        {!narrow && soc}
      </div>
      {(node.direction || (narrow && soc)) && (
        <div className="flow-node-dir">
          <span>{node.direction}</span>
          {narrow && soc}
        </div>
      )}
      {node.plan && (
        <div
          className="flow-node-plan"
          data-gap={node.gap ? true : undefined}
          title={node.gap ? `${node.plan} · ${node.gap}` : node.plan}
        >
          {node.plan}
        </div>
      )}
      {node.expected && (
        <div className="flow-node-expected" title={expectedText(q, past) ?? undefined}>
          {narrow ? '≈' : 'expected'} {node.expected}
        </div>
      )}
    </div>
  )
}

function Soc({
  q,
  from,
  to,
  min,
  max,
  past,
  fetchedAt,
  now,
  tz,
}: {
  q: NowQuantity | undefined
  from: number | null
  to: number | null
  min: number | null
  max: number | null
  past: boolean
  fetchedAt: number
  now: Date
  tz: string
}) {
  const actual = isNumber(q?.measured) ? q.measured : null
  if (actual === null && to === null) return null
  const pct = (v: number) => formatFraction(v, 0)
  const planned = to === null ? null : from === null ? `${pct(to)} at the end` : `${pct(from)} → ${pct(to)}`
  const lo = Math.min(from ?? to ?? 0, to ?? 0)
  const hi = Math.max(from ?? to ?? 0, to ?? 0)
  const { age, title } = sensorAge(q, past, fetchedAt, now, tz)
  const differs = q?.differs === true
  return (
    <div className="slot-fact">
      <div className="slot-fact-label">
        <span>Battery state of charge</span>
        {age && <span title={title}>{age}</span>}
      </div>
      <div className="slot-fact-row">
        <span className="slot-fact-value" title={title}>
          {actual !== null ? formatFraction(actual) : planned}
        </span>
        {actual !== null && planned && (
          <span className="slot-fact-plan" data-differs={differs || undefined}>
            plan {planned}
          </span>
        )}
      </div>
      <div
        className="soc-bar"
        role="img"
        aria-label={`State of charge ${actual !== null ? `${formatFraction(actual)}, ` : ''}planned ${planned ?? '—'}`}
      >
        <span className="soc-fill" style={{ width: `${(actual ?? to ?? 0) * 100}%` }} />
        {isNumber(min) && min > 0 && <span className="soc-reserve" style={{ width: `${min * 100}%` }} />}
        {isNumber(max) && max < 1 && <span className="soc-ceiling" style={{ left: `${max * 100}%` }} />}
        {to !== null && (
          <span
            className="soc-plan"
            data-differs={differs || undefined}
            style={{ left: `${lo * 100}%`, width: `max(3px, ${(hi - lo) * 100}%)` }}
          />
        )}
      </div>
      <div className="slot-scale">
        <span>0 %</span>
        {isNumber(min) && min > 0 && <span>reserve {pct(min)}</span>}
        <span>100 %</span>
      </div>
    </div>
  )
}

function Price({ row, prices, slotStart, tz }: { row: PlanRow; prices: PlanPrice[]; slotStart: string; tz: string }) {
  const importPrice = num(row, 'unit_load_cost')
  const exportPrice = num(row, 'unit_prod_price')
  if (importPrice === null && exportPrice === null) return null
  const day = priceInDay(prices, slotStart, importPrice, tz)
  return (
    <div className="slot-fact">
      <div className="slot-fact-label">
        <span>Price this slot</span>
      </div>
      {importPrice !== null && (
        <div className="slot-fact-row">
          <span>Import</span>
          <span className="slot-fact-value">{formatPrice(importPrice)}</span>
        </div>
      )}
      {day && (
        <>
          <div className="price-range" role="img" aria-label={`Import price ${day.word}`}>
            <span className="price-dot" style={{ left: `${day.position * 100}%` }} />
          </div>
          <div className="slot-scale">
            <span>{formatPrice(day.min, 'eur', false)}</span>
            <span className="slot-scale-word">{day.word}</span>
            <span>{formatPrice(day.max, 'eur', false)}</span>
          </div>
        </>
      )}
      {exportPrice !== null && (
        <div className="slot-fact-row" style={{ marginTop: 10 }}>
          <span>Export</span>
          <span className="slot-fact-value">{formatPrice(exportPrice)}</span>
        </div>
      )}
    </div>
  )
}

/** A slot as a flow: what is measured (or, for the next slot, planned) as the big numbers, the plan under them,
 *  a line that says what happens, the state of charge and the price; for this slot also what the inverter is set to. */
export function ThisSlot({
  row,
  fromRow,
  columns,
  now: quantities,
  past = false,
  charger,
  inverter,
  plan,
  socMin,
  socMax,
  prices,
  slotStart,
  fetchedAt,
  tz,
}: {
  row: PlanRow
  /** The row the slot's state of charge starts from (the slot before's end), when known. */
  fromRow?: PlanRow | null
  columns: string[]
  /** What is measured: now, or for a slot that has ended (`past`) the quarter-hour means. None for the next slot. */
  now?: NowByKey
  past?: boolean
  charger?: ChargerNow | null
  inverter?: InverterNow | null
  /** When the plan in force was made, and by which run. */
  plan?: { generatedAt: string | null; runId: number | null }
  socMin?: number | null
  socMax?: number | null
  prices: PlanPrice[]
  slotStart: string
  fetchedAt: number
  tz: string
}) {
  const clock = useNow(5_000)
  // the layout follows the room the flow has (not the window): the wide one when it fits, else the narrow one,
  // scaled down when even that doesn't fit
  const wrap = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState<number | null>(null)
  useEffect(() => {
    const el = wrap.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setRoom(entry!.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const narrow = room !== null && room < WIDE_FLOW.width
  const layout = narrow ? NARROW_FLOW : WIDE_FLOW
  const scale = room !== null ? Math.min(1, room / layout.width) : 1
  const deferrables = deferrableColumns(columns)
  const withDeferrable = deferrables.length > 0
  const deferrable = withDeferrable ? (charger ? 'EV' : 'Deferrable') : null
  const planned = planValues(row, columns)
  const measured = measuredValues(quantities, past ? null : charger)
  const shown = { ...planned }
  for (const key of Object.keys(measured) as (keyof typeof measured)[]) shown[key] = measured[key] ?? planned[key]
  const anyMeasured = Object.values(measured).some((v) => v !== null)
  const users = charger ? 'the EV' : 'the deferrable load'
  const headline = flowHeadline(shown, users)
  const planHeadline = flowHeadline(planned, users)
  const agree = agreement(quantities, planned, measured)
  const nodes = flowNodes(planned, measured, {
    deferrable,
    curtailed: num(row, 'P_PV_curtailment'),
    charger,
    soc: {
      measured: isNumber(quantities?.soc?.measured) ? quantities.soc.measured : null,
      planned: socOf(row),
      differs: quantities?.soc?.differs,
    },
    expected: { batt: quantities?.batt?.expected, grid: quantities?.grid?.expected },
  })
  const segments = flowSegments(shown, layout, withDeferrable)
  const boxes = segments.map((s) => ({ s, ...segmentBox(s, layout) }))
  const tone = inverter?.in_control && inverter.state ? modeTone(inverter.state) : null
  // "The battery covers…" reads "the battery covers…" mid-line; "PV covers…" keeps its capitals
  const lowerFirst = (text: string) => (/^[A-Z][a-z]/.test(text) ? `${text[0]!.toLowerCase()}${text.slice(1)}` : text)

  return (
    <div className="slot">
      <div className="slot-top">
        {tone && (
          <span className="slot-mode" title={`The inverter's passive mode: ${tone.state}`}>
            <span className="slot-mode-swatch" style={{ background: tone.fill }} aria-hidden="true" />
            {tone.short}
          </span>
        )}
        <span className="slot-headline">{headline}</span>
        {agree && (
          <span className="slot-agree" data-color={agree.color}>
            <Lamp color={agree.color} />
            {agree.text}
          </span>
        )}
      </div>
      {(anyMeasured || plan?.generatedAt) && (
        <p className="slot-line">
          {anyMeasured && planHeadline !== headline && (
            <>
              <strong>Plan:</strong> {lowerFirst(planHeadline)}
              {plan?.generatedAt && ' · '}
            </>
          )}
          {plan?.generatedAt && (
            <>
              planned {formatClock(plan.generatedAt, tz)}
              {plan.runId && (
                <>
                  {' · '}
                  <Link to={`/runs/${plan.runId}`}>run #{plan.runId}</Link>
                </>
              )}
            </>
          )}
        </p>
      )}
      {inverter && (
        <p className="slot-line">
          <LabelledLamp
            color={inverter.in_control ? 'green' : 'amber'}
            text={inverter.in_control ? 'Inverter set to' : 'Inverter not in control:'}
          />{' '}
          {inverter.in_control ? inverterParts(inverter).join(' · ') : inverter.reason}
          {inverter.written_at && (
            <>
              {' · '}written {formatClock(inverter.written_at, tz)}
              {inverter.run_id && (
                <>
                  {' · '}
                  <Link to={`/runs/${inverter.run_id}`}>run #{inverter.run_id}</Link>
                </>
              )}
            </>
          )}
        </p>
      )}
      <div className="slot-body">
        <div className="flow-wrap" ref={wrap} style={{ height: layout.height * scale }}>
          <div
            className="flow"
            data-size={narrow ? 'narrow' : 'wide'}
            role="group"
            aria-label={`Where the power goes: ${headline}`}
            style={{
              width: layout.width,
              height: layout.height,
              ...(scale < 1 && { transform: `scale(${scale})`, margin: 0 }),
            }}
          >
            {boxes.map(({ s, line, idle }) => (
              <span
                key={s.key}
                className="flow-line"
                data-idle={idle || undefined}
                data-dir={s.dir}
                data-flat={s.from[1] === s.to[1] || undefined}
                style={{ ...line, backgroundColor: idle ? undefined : s.color }}
                aria-hidden="true"
              />
            ))}
            {boxes.map(({ s, arrow }) =>
              arrow ? (
                <span
                  key={s.key}
                  className="flow-arrow"
                  style={{
                    left: arrow.left,
                    top: arrow.top,
                    width: arrow.width,
                    height: arrow.height,
                    clipPath: arrow.clip,
                    background: s.color,
                  }}
                  aria-hidden="true"
                />
              ) : null,
            )}
            <span className="flow-hub" style={{ left: layout.hub.x, top: layout.hub.y }} aria-hidden="true" />
            {nodes.map((node) => (
              <FlowBox
                key={node.key}
                node={node}
                layout={layout}
                narrow={narrow}
                withDeferrable={withDeferrable}
                q={node.key === 'ev' ? undefined : quantities?.[node.key]}
                socQ={node.key === 'batt' ? quantities?.soc : undefined}
                past={past}
                fetchedAt={fetchedAt}
                now={clock}
                tz={tz}
              />
            ))}
          </div>
        </div>
        <div className="slot-side">
          <Soc
            q={quantities?.soc}
            from={fromRow === undefined ? null : socOf(fromRow)}
            to={socOf(row)}
            min={socMin ?? null}
            max={socMax ?? null}
            past={past}
            fetchedAt={fetchedAt}
            now={clock}
            tz={tz}
          />
          <Price row={row} prices={prices} slotStart={slotStart} tz={tz} />
        </div>
      </div>
    </div>
  )
}
