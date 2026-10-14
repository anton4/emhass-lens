// The value popup next to a chart's cursor (TimeChart's `popup`): the slot (or the pointer's own moment, the slot then
// heading the rows), whether it is measured or plan, an optional tinted block (the market command at the pointer), and
// one row per line with the plan at the time beside the measured value. Charts that share a syncKey all show theirs at the
// same moment; the one under the pointer marks the line nearest it, and a chart of columns rings the column. Below
// 520 px of plot only the chart under the pointer shows one, across the top of its plot.

import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { nearestRow, placePopup, popupRows, slotRange, type PopupSeries } from '../../lib/chartPopup'
import type { CursorStore, PopupBlock, PopupExtra, PopupTag } from './cursorStore'

const DOCK_BELOW = 520

const cssColor = (color: string) => (color.startsWith('--') ? `var(${color})` : color)

export function ChartPopup({
  store,
  read,
}: {
  store: CursorStore
  read: () => {
    series: PopupSeries[]
    x: number[]
    timeZone?: string
    tag?: (t: number) => PopupTag | null
    extra?: (t: number, time: number) => PopupExtra[]
    head?: (t: number, time: number) => string | null
    block?: (t: number, time: number) => PopupBlock | null
  }
}) {
  const { over, at } = useSyncExternalStore(store.subscribe, store.get)
  const box = useRef<HTMLDivElement>(null)
  // placed from an estimate of its height, then corrected to the height it really has
  useLayoutEffect(() => {
    const el = box.current
    if (!el || el.dataset.docked) return
    const anchorY = Number(el.dataset.anchor)
    const plot = Number(el.dataset.plot)
    const h = el.offsetHeight
    const top = h >= plot ? (plot - h) / 2 : Math.min(Math.max(anchorY - h / 2, 0), plot - h)
    el.style.top = `${top}px`
  })
  if (!over || !at) return null
  const docked = at.width < DOCK_BELOW
  if (docked && at.pointerY === null) return null
  const { series, x, timeZone, tag: tagFor, extra: extraFor, head: headFor, block: blockFor } = read()
  const { rows, hasThen } = popupRows(series, at.idx)
  const t = x[at.idx]
  const extra = t !== undefined ? (extraFor?.(t, at.time) ?? []) : []
  const block = t !== undefined ? (blockFor?.(t, at.time) ?? null) : null
  if ((rows.length === 0 && extra.length === 0 && !block) || t === undefined) return null
  const end = x[at.idx + 1] ?? t + 900
  const head = headFor?.(t, at.time) ?? null
  const near = at.pointerY !== null ? nearestRow(at.points, at.pointerY) : null
  const anchorY = at.column?.top ?? at.points.find((p) => p.series === near)?.y ?? at.points[0]?.y ?? at.height / 2
  const estimate =
    46 +
    20 * (rows.length + extra.length) +
    (hasThen ? 18 : 0) +
    (rows.length && extra.length ? 6 : 0) +
    (head && rows.length ? 18 : 0) +
    (block ? 40 + 20 * block.rows.length + 17 * (block.foot?.length ?? 0) : 0)
  const place = placePopup({ left: at.left, anchorY, width: at.width, height: at.height, popupHeight: estimate })
  const tag = tagFor?.(t) ?? null
  const ring = near !== null && !docked ? at.points.find((p) => p.series === near) : undefined
  return createPortal(
    <>
      {ring && <span className="chart-pop-ring" style={{ left: at.left, top: ring.y }} aria-hidden="true" />}
      {at.column && (
        <span
          className="chart-col-ring"
          style={{
            left: at.column.left - 2,
            top: at.column.top - 3,
            width: at.column.width + 4,
            height: at.column.height + 5,
          }}
          aria-hidden="true"
        />
      )}
      <div
        ref={box}
        className="chart-pop"
        data-flip={(place.flip && !docked) || undefined}
        data-docked={docked || undefined}
        data-anchor={anchorY}
        data-plot={at.height}
        style={docked ? undefined : { left: place.left, top: place.top }}
        aria-hidden="true"
      >
        <div className="chart-pop-head">
          <span className="chart-pop-time">{head ?? slotRange(t, end, timeZone)}</span>
          {tag && (
            <span className="chart-pop-tag" data-tone={tag.tone ?? 'neutral'}>
              {tag.text}
            </span>
          )}
        </div>
        {block && <PopupBlockView block={block} />}
        <div className="chart-pop-rows" data-then={hasThen || undefined}>
          {head && rows.length > 0 && (
            <div className="chart-pop-sub">Quarter-hour {slotRange(t, end, timeZone, false)}</div>
          )}
          {hasThen && (
            <div className="chart-pop-row chart-pop-cols">
              <span />
              <span>measured</span>
              <span className="chart-pop-then">
                <span className="chart-pop-dash" />
                planned then
              </span>
            </div>
          )}
          {rows.map((r) => (
            <div
              key={r.series}
              className="chart-pop-row"
              data-near={r.series === near || undefined}
              data-muted={r.muted || undefined}
              data-total={r.total || undefined}
            >
              <span className="chart-pop-name">
                {r.area ? (
                  <span className="chart-pop-square" style={{ background: cssColor(r.color) }} />
                ) : (
                  <span
                    className="chart-pop-swatch"
                    style={{ borderTopColor: cssColor(r.color), borderTopStyle: r.dashed ? 'dashed' : 'solid' }}
                  />
                )}
                {r.name}
              </span>
              <span className="chart-pop-value">
                <b>{r.value}</b>
                {r.describe && <i> {r.describe}</i>}
              </span>
              {hasThen && <span className="chart-pop-then">{r.then ?? ''}</span>}
            </div>
          ))}
          {extra.map((r, i) => (
            <div key={`extra-${i}`} className="chart-pop-row" data-rule={(i === 0 && rows.length > 0) || undefined}>
              <span className="chart-pop-name">
                <span
                  className="chart-pop-square"
                  data-hatch={r.hatch || undefined}
                  style={r.hatch ? undefined : { background: cssColor(r.color) }}
                />
                {r.name}
              </span>
              <span className="chart-pop-value">
                <b>{r.value}</b>
              </span>
              {hasThen && <span className="chart-pop-then" />}
            </div>
          ))}
        </div>
      </div>
    </>,
    over,
  )
}

/** The tinted block: a title and its source, rows with a swatch each, and the lines under a rule. */
function PopupBlockView({ block }: { block: PopupBlock }) {
  return (
    <div className="chart-pop-block" data-tone={block.tone}>
      <div className="chart-pop-block-title">
        <b>{block.title}</b>
        {block.sub && <span>{block.sub}</span>}
      </div>
      <div className="chart-pop-block-rows">
        {block.rows.map((r) => (
          <div key={r.name} className="chart-pop-block-row" data-alert={r.alert || undefined}>
            <span className="chart-pop-name">
              <span
                className="chart-pop-mark"
                data-swatch={r.swatch}
                style={{ color: cssColor(r.color) }}
              />
              {r.name}
            </span>
            <b>{r.value}</b>
            <i>{r.note ?? ''}</i>
          </div>
        ))}
      </div>
      {block.foot && block.foot.length > 0 && (
        <div className="chart-pop-block-foot">
          {block.foot.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}
    </div>
  )
}
