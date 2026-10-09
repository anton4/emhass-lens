import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { keys, useEmhass, useEntities } from '../../api/queries'
import type { EmhassStatus } from '../../api/types'
import { LabelledLamp } from '../../components/Lamp'

interface EntityPickerProps {
  id: string
  value: string
  domains: string | string[] | undefined
  disabled: boolean
  invalid: boolean
  onValue: (value: string) => void
}

/** Text input with Home Assistant entity suggestions and the chosen entity's current state. */
export function EntityPicker({ id, value, domains, disabled, invalid, onValue }: EntityPickerProps) {
  const domainList = Array.isArray(domains) ? domains.join(',') : (domains ?? '')
  const entities = useEntities(domainList)
  const listId = `${id}-entities`
  const match = entities.data?.find((e) => e.entity_id === value)
  return (
    <div className="entity-picker">
      <input
        id={id}
        type="text"
        list={listId}
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
        aria-invalid={invalid || undefined}
        placeholder={`${domainList.split(',')[0] || 'sensor'}.example`}
        value={value}
        onChange={(e) => onValue(e.target.value)}
      />
      <datalist id={listId}>
        {(entities.data ?? []).map((e) => (
          <option key={e.entity_id} value={e.entity_id}>
            {e.name ? `${e.name} · ` : ''}
            {e.state}
            {e.unit ? ` ${e.unit}` : ''}
          </option>
        ))}
      </datalist>
      {value && match && (
        <div className="entity-state">
          {match.name && <span>{match.name}: </span>}
          <strong className="num">
            {match.state}
            {match.unit ? ` ${match.unit}` : ''}
          </strong>
        </div>
      )}
      {value && entities.isSuccess && !match && (
        <div className="field-error" role="status">
          Not found in Home Assistant
        </div>
      )}
      {entities.isError && (
        <div className="entity-state faint" title={(entities.error as Error).message}>
          No entity suggestions: Home Assistant can't be asked right now
        </div>
      )}
    </div>
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
