import { useCallback, useId, useRef, useState } from 'react'
import { multiSummary, type MultiValue } from '../lib/multiFilter'
import { Icon } from './Icon'
import { Lamp, type LampColor } from './Lamp'
import { useDismiss } from './useDismiss'

const PANEL_WIDTH = 300 // px, as in .multi-filter-panel
const GUTTER = 16

export interface MultiOption {
  value: string
  label: string
  lamp?: LampColor
}

/** A toolbar filter that keeps or leaves out any number of values: a button that says what it keeps ("All jobs",
 *  "2 jobs", "All but Error") and opens a panel with Include / Exclude and a checkbox per option. */
export function MultiFilter({
  label,
  noun,
  options,
  value,
  onChange,
}: {
  label: string
  noun: string
  options: MultiOption[]
  value: MultiValue
  onChange: (value: MultiValue) => void
}) {
  const [open, setOpen] = useState(false)
  // Where the panel starts relative to the button, so it stays on a narrow screen
  const [shift, setShift] = useState(0)
  // With nothing ticked the URL holds no mode, so the switch remembers it here until a box is ticked
  const [excludeDraft, setExcludeDraft] = useState(value.exclude)
  const exclude = value.values.length > 0 ? value.exclude : excludeDraft
  const wrap = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, wrap, close)

  const picked = value.values.map((v) => options.find((o) => o.value === v)?.label ?? v)
  const setMode = (next: boolean) => {
    setExcludeDraft(next)
    if (value.values.length > 0) onChange({ values: value.values, exclude: next })
  }
  const toggleOpen = () => {
    const box = wrap.current?.getBoundingClientRect()
    const page = document.documentElement.clientWidth
    const width = Math.min(PANEL_WIDTH, page - 2 * GUTTER)
    setShift(box ? Math.max(GUTTER - box.left, Math.min(0, page - GUTTER - width - box.left)) : 0)
    setOpen((v) => !v)
  }
  const toggle = (v: string) =>
    onChange({
      values: value.values.includes(v) ? value.values.filter((x) => x !== v) : [...value.values, v],
      exclude,
    })

  return (
    <div className="multi-filter" ref={wrap}>
      <button
        type="button"
        className="multi-filter-button"
        data-active={value.values.length > 0 || undefined}
        aria-expanded={open}
        aria-controls={panelId}
        title={picked.length > 1 ? `${exclude ? 'All but ' : ''}${picked.join(', ')}` : undefined}
        onClick={toggleOpen}
      >
        <span className="visually-hidden">{label}: </span>
        {multiSummary(noun, picked, exclude)}
        <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div className="multi-filter-panel" id={panelId} role="group" aria-label={label} style={{ left: shift }}>
          <div className="multi-filter-head">
            <div className="segmented" role="group" aria-label="Mode">
              <button type="button" aria-pressed={!exclude} onClick={() => setMode(false)}>
                Include
              </button>
              <button type="button" aria-pressed={exclude} onClick={() => setMode(true)}>
                Exclude
              </button>
            </div>
            <button
              type="button"
              className="quiet"
              disabled={value.values.length === 0}
              onClick={() => onChange({ values: [], exclude })}
            >
              Clear
            </button>
          </div>
          <p className="multi-filter-hint">
            {exclude ? `Hides the ${noun} you tick.` : `Shows only the ${noun} you tick.`}
          </p>
          <ul className="multi-filter-list">
            {options.map((o) => (
              <li key={o.value}>
                <label className="check" data-excluded={(exclude && value.values.includes(o.value)) || undefined}>
                  <input type="checkbox" checked={value.values.includes(o.value)} onChange={() => toggle(o.value)} />
                  {o.lamp && <Lamp color={o.lamp} />}
                  {o.label}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
