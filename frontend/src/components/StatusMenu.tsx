import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useEvents } from '../api/events'
import { useJobs } from '../api/queries'
import type { StatusInfo } from '../api/types'
import { COMPONENT_NAMES } from '../lib/components'
import { driverSpec } from '../lib/driver'
import { formatCountdown, formatTime } from '../lib/format'
import { statusColor } from '../lib/status'
import { Icon } from './Icon'
import { LabelledLamp, Lamp, type LampColor } from './Lamp'
import { ModeSwitch } from './ModeSwitch'
import { useNow } from './useNow'

const MODE_TEXT: Record<string, string> = { off: 'OFF', dry_run: 'DRY RUN', live: 'LIVE' }

const DRIVES: Record<string, string> = {
  app: 'EMHASS Lens drives',
  legacy: 'HACS integration drives',
  both: 'Both drive: conflict',
  none: 'Nobody drives',
}

/** The chip's colour: a driver conflict is an alarm; otherwise the mode's own colour. */
function chipColor(s: StatusInfo): LampColor {
  if (s.driver === 'both') return 'red'
  if (s.emhass_mode === 'live') return 'green'
  if (s.emhass_mode === 'dry_run') return 'blue'
  return 'neutral'
}

export function StreamLamp() {
  const { state } = useEvents()
  const map = {
    live: { color: 'green', text: 'Live updates' },
    connecting: { color: 'neutral', text: 'Connecting' },
    reconnecting: { color: 'amber', text: 'Reconnecting' },
    polling: { color: 'amber', text: 'Polling every 10 s' },
  } as const
  const spec = map[state]
  return <LabelledLamp color={spec.color} text={spec.text} pulse={state === 'reconnecting'} />
}

function NextMpc() {
  const jobs = useJobs()
  const now = useNow(1000)
  const mpc = jobs.data?.find((j) => j.id === 'emhass.mpc')
  if (!mpc) return null
  return (
    <div className="status-row">
      <span className="status-label">Next MPC</span>
      {mpc.running ? (
        <span className="labelled-lamp">
          <span className="spinner" aria-hidden="true" /> Running now
        </span>
      ) : mpc.paused ? (
        <span>Paused</span>
      ) : mpc.next_run ? (
        <span>
          <time dateTime={mpc.next_run}>{formatTime(mpc.next_run, now)}</time>
          <span className="faint"> · in </span>
          <span className="countdown">{formatCountdown(mpc.next_run, now)}</span>
        </span>
      ) : (
        <span className="faint">Only on demand</span>
      )}
    </div>
  )
}

/** The status chip in the top bar ("LIVE · EMHASS Lens drives"). It opens a panel with the EMHASS mode switch,
 *  who drives EMHASS, the next MPC run, every component's lamp and the live-update state. */
export function StatusMenu({ status }: { status: StatusInfo }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const driver = driverSpec(status.driver)

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      // Dialogs the panel opens (mode confirmation) live in the top layer, outside the wrapper
      const target = event.target as Element | null
      if (target?.closest('dialog')) return
      if (wrap.current && !wrap.current.contains(target)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="status-menu" ref={wrap}>
      <button
        type="button"
        className="status-chip"
        data-color={chipColor(status)}
        aria-expanded={open}
        aria-controls={panelId}
        title="EMHASS mode, who drives EMHASS and the state of every part"
        onClick={() => setOpen((v) => !v)}
      >
        <Lamp color={chipColor(status)} />
        <span className="status-mode">{MODE_TEXT[status.emhass_mode] ?? status.emhass_mode}</span>
        <span className="status-sep" aria-hidden="true">
          ·
        </span>
        <span className="status-driver">{DRIVES[status.driver] ?? driver.text}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div className="status-panel" id={panelId} role="region" aria-label="Status">
          <div className="status-section">
            <div className="status-label">EMHASS mode</div>
            <ModeSwitch
              mode={status.emhass_mode}
              writable={status.writable}
              driver={status.driver}
              safeMode={status.safe_mode}
            />
          </div>
          <div className="status-section">
            <div className="status-row">
              <span className="status-label">Driving EMHASS</span>
              <LabelledLamp color={driver.color} text={driver.text} />
            </div>
            <p className="status-explain">{driver.explain}</p>
            <NextMpc />
          </div>
          <div className="status-section">
            <div className="status-label">Parts</div>
            <ul className="status-parts">
              {Object.entries(status.components).map(([name, comp]) => (
                <li key={name} title={comp.detail ?? undefined}>
                  <LabelledLamp color={statusColor(comp.status)} text={COMPONENT_NAMES[name] ?? name} />
                  {comp.detail && <span className="status-part-detail">{comp.detail}</span>}
                </li>
              ))}
            </ul>
            <div className="status-row">
              <StreamLamp />
              <Link to="/health" onClick={() => setOpen(false)}>
                Open Health
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
