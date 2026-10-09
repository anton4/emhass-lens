import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { api } from '../../api/client'
import { keys, useEmhass, useEntity, useEntitySearch } from '../../api/queries'
import type { EmhassStatus, EntityOption } from '../../api/types'
import { LabelledLamp } from '../../components/Lamp'
import { entityDomains, entityReading, matchSegments } from '../../lib/entities'

const LIMIT = 50

interface EntityPickerProps {
  id: string
  value: string
  domains: string | string[] | undefined
  disabled: boolean
  invalid: boolean
  onValue: (value: string) => void
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}

/**
 * Text input for an entity id that suggests Home Assistant entities as you type (a combobox), and
 * shows the chosen entity's current state. Any id can still be typed; the suggestions only list the
 * field's domains, best matches first, searched in EMHASS Lens so large installs work too.
 */
export function EntityPicker({ id, value, domains, disabled, invalid, onValue }: EntityPickerProps) {
  const domainList = entityDomains(domains)
  const [open, setOpen] = useState(false)
  // Right after opening the whole list shows; once something is typed it is filtered by the text.
  const [typed, setTyped] = useState(false)
  const [active, setActive] = useState(-1)
  const search = useDebounced(typed ? value : '', 150)
  const results = useEntitySearch(domainList, search, LIMIT, open)
  const current = useEntity(value, !open)
  const listId = useId()
  const listRef = useRef<HTMLUListElement>(null)

  const options = results.data ?? []
  const activeIndex = Math.min(active, options.length - 1)

  useEffect(() => {
    if (!open || activeIndex < 0) return
    listRef.current?.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  const show = () => {
    if (disabled || open) return
    setOpen(true)
    setTyped(false)
    setActive(-1)
  }
  const close = () => {
    setOpen(false)
    setActive(-1)
  }
  const choose = (option: EntityOption) => {
    onValue(option.entity_id)
    close()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) show()
      else setActive(Math.min(activeIndex + 1, options.length - 1))
    } else if (e.key === 'ArrowUp' && open) {
      e.preventDefault()
      setActive(Math.max(activeIndex - 1, 0))
    } else if (e.key === 'Enter' && open && activeIndex >= 0 && options[activeIndex]) {
      e.preventDefault()
      choose(options[activeIndex])
    } else if (e.key === 'Escape' && open) {
      e.preventDefault()
      close()
    }
  }

  const words = typed ? value : ''
  const match = current.data
  return (
    <div className="entity-picker">
      <div className="entity-input">
        <input
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          aria-invalid={invalid || undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          placeholder={`${domainList[0] ?? 'sensor'}.example`}
          value={value}
          onClick={show}
          onBlur={close}
          onKeyDown={onKeyDown}
          onChange={(e) => {
            onValue(e.target.value)
            setOpen(true)
            setTyped(true)
            setActive(0)
          }}
        />
        {open && (
          <ul ref={listRef} id={listId} role="listbox" className="entity-list" aria-label="Home Assistant entities">
            {options.map((option, index) => (
              <li
                key={option.entity_id}
                id={`${listId}-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === activeIndex}
                className={option.entity_id === value ? 'entity-option entity-option-current' : 'entity-option'}
                // mousedown, not click: picking must happen before the input's blur closes the list
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(option)
                }}
                onMouseMove={() => index !== activeIndex && setActive(index)}
              >
                <span className="entity-option-name">
                  <Highlighted text={option.name ?? option.entity_id} words={words} />
                </span>
                <span className="entity-option-state">{entityReading(option)}</span>
                <span className="entity-option-id">
                  <Highlighted text={option.entity_id} words={words} />
                </span>
              </li>
            ))}
            <ListNote results={results} count={options.length} domains={domainList} />
          </ul>
        )}
      </div>
      {!open && value && match && (
        <div className="entity-state">
          {match.name && <span>{match.name}: </span>}
          <strong className="num">{entityReading(match)}</strong>
        </div>
      )}
      {!open && value && match === null && (
        <div className="field-error" role="status">
          Not found in Home Assistant
        </div>
      )}
      {!open && current.isError && (
        <div className="entity-state faint" title={current.error.message}>
          No entity suggestions: Home Assistant can't be asked right now
        </div>
      )}
    </div>
  )
}

function Highlighted({ text, words }: { text: string; words: string }) {
  return matchSegments(text, words).map((segment, i) =>
    segment.match ? <mark key={i}>{segment.text}</mark> : <span key={i}>{segment.text}</span>,
  )
}

function ListNote({
  results,
  count,
  domains,
}: {
  results: ReturnType<typeof useEntitySearch>
  count: number
  domains: string[]
}) {
  let note: string | null = null
  if (results.isError) note = `Can't list Home Assistant entities (${results.error.message}). You can still type the entity id.`
  else if (results.isPending) note = 'Loading entities…'
  else if (count === 0) note = `No matching ${domains.length ? domains.join(' / ') + ' ' : ''}entities.`
  else if (count >= LIMIT) note = `Showing the best ${LIMIT} matches. Type more to narrow them down.`
  if (!note) return null
  return (
    <li className="entity-list-note" role="presentation">
      {note}
    </li>
  )
}

/** Live EMHASS status beside the address field, with a search button. */
export function EmhassUrlStatus({ disabled }: { disabled: boolean }) {
  const emhass = useEmhass()
  const queryClient = useQueryClient()
  const discover = useMutation({
    mutationFn: () => api.post<EmhassStatus>('/api/emhass/discover'),
    onSuccess: (data) => queryClient.setQueryData(keys.emhass, data),
  })
  const e = emhass.data
  return (
    <div className="entity-state url-status">
      {e && (
        <LabelledLamp
          color={e.reachable ? 'green' : e.reachable === false ? 'red' : 'neutral'}
          text={
            e.reachable
              ? `EMHASS ${e.version ?? ''} at ${e.url ?? '?'}${e.url_source === 'discovered' ? ' (found automatically)' : ''}`
              : e.reachable === false
                ? `Not reachable${e.last_error ? `: ${e.last_error}` : ''}`
                : 'Not checked yet'
          }
        />
      )}
      <button type="button" className="quiet" disabled={disabled || discover.isPending} onClick={() => discover.mutate()}>
        {discover.isPending ? 'Searching…' : 'Search'}
      </button>
      {discover.error && <span className="field-error">{(discover.error as Error).message}</span>}
    </div>
  )
}
