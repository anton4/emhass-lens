import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import { useSettingsSchema } from '../api/queries'
import { NAV_PAGES } from '../lib/nav'
import { Icon } from './Icon'

export interface PaletteAction {
  label: string
  hint?: string
  run: () => void
}

interface Command {
  id: string
  group: string
  label: string
  hint?: string
  run: () => void
}

/** Whether every word of the query appears in the text (case-insensitive). */
function matches(text: string, query: string): boolean {
  const hay = text.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word))
}

/** ⌘K / Ctrl+K: jump to a page, a run or a settings section, or run an action, by typing. */
export function CommandPalette({ open, onClose, actions }: { open: boolean; onClose: () => void; actions: PaletteAction[] }) {
  const ref = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const navigate = useNavigate()
  const schema = useSettingsSchema()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      setQuery('')
      setActive(0)
      dialog.showModal()
      input.current?.focus()
    }
    if (!open && dialog.open) dialog.close()
  }, [open])

  const commands = useMemo(() => {
    const go = (to: string) => () => navigate(to)
    const out: Command[] = []
    const q = query.trim()
    const runId = /^#?(\d+)$/.exec(q)?.[1]
    if (runId) {
      out.push({ id: 'run', group: 'Runs', label: `Open run ${runId}`, run: go(`/runs/${runId}`) })
      out.push({ id: 'run-logs', group: 'Runs', label: `Logs of run ${runId}`, run: go(`/logs?run=${runId}`) })
    }
    for (const page of NAV_PAGES) {
      out.push({
        id: `page:${page.to}`,
        group: 'Go to',
        label: page.label,
        hint: page.key ? `G ${page.key.toUpperCase()}` : undefined,
        run: go(page.to),
      })
    }
    actions.forEach((action, i) => out.push({ id: `action:${i}`, group: 'Actions', ...action }))
    out.push({ id: 'problems', group: 'Actions', label: 'Show problems', run: go('/health?focus=problems') })
    for (const [key, node] of Object.entries(schema.data?.properties ?? {})) {
      out.push({
        id: `settings:${key}`,
        group: 'Settings',
        label: `Settings › ${node.title ?? key}`,
        run: go(`/settings?section=${encodeURIComponent(key)}`),
      })
    }
    return runId ? out.filter((c) => c.group === 'Runs' || matches(c.label, q)) : out.filter((c) => matches(c.label, q))
  }, [query, actions, schema.data, navigate])

  const choose = (command: Command | undefined) => {
    if (!command) return
    onClose()
    command.run()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((i) => Math.min(i + 1, commands.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(commands[active])
    }
  }

  let lastGroup = ''
  return (
    <dialog
      ref={ref}
      className="palette"
      aria-label="Search or jump to"
      onClose={onClose}
      onCancel={onClose}
      onClick={(event) => {
        // A click on the backdrop (the dialog element itself, outside the box) closes it
        if (event.target === ref.current) onClose()
      }}
    >
      <div className="palette-box">
        <label className="palette-input">
          <Icon name="search" />
          <span className="visually-hidden">Search pages, runs, settings and actions</span>
          <input
            ref={input}
            type="text"
            value={query}
            placeholder="Search or jump to… (a number opens that run)"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={commands[active] ? `${listId}-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
          />
          <kbd>Esc</kbd>
        </label>
        <ul className="palette-list" id={listId} role="listbox" aria-label="Results">
          {commands.length === 0 && <li className="palette-empty">Nothing matches “{query}”.</li>}
          {commands.map((command, i) => {
            const heading = command.group !== lastGroup ? command.group : null
            lastGroup = command.group
            return (
              <li key={command.id} role="presentation">
                {heading && <div className="palette-group">{heading}</div>}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className="palette-item"
                  onPointerMove={() => setActive(i)}
                  onClick={() => choose(command)}
                >
                  <span>{command.label}</span>
                  {command.hint ? <kbd>{command.hint}</kbd> : i === active ? <Icon name="arrowRight" size={14} /> : null}
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </dialog>
  )
}
