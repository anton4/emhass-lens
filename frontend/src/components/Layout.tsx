import { Link, NavLink, Outlet } from 'react-router'
import { useEvents } from '../api/events'
import { useStatus, useVersion } from '../api/queries'
import { LabelledLamp } from './Lamp'
import { COMPONENT_NAMES } from '../lib/components'
import { driverSpec } from '../lib/driver'
import { statusColor } from '../lib/status'
import { ModeSwitch } from './ModeSwitch'

const UI_VERSION = import.meta.env.VITE_APP_VERSION || 'dev'

const NAV: { to: string; label: string; end?: boolean; tag?: string }[] = [
  { to: '/', label: 'Plan', end: true },
  { to: '/inputs', label: 'Inputs' },
  { to: '/inverter', label: 'Inverter', tag: 'experimental' },
  { to: '/charger', label: 'EV charger', tag: 'experimental' },
  { to: '/market', label: 'Market', tag: 'experimental' },
  { to: '/runs', label: 'Runs' },
  { to: '/logs', label: 'Logs' },
  { to: '/health', label: 'Health' },
  { to: '/settings', label: 'Settings' },
]

function reload() {
  const url = new URL(window.location.href)
  url.searchParams.set('v', String(Date.now()))
  window.location.replace(url.toString())
}

function StreamLamp() {
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

export function Layout() {
  const status = useStatus()
  const version = useVersion()
  const s = status.data
  const problems = s?.problems.length ?? 0
  // An App update (different version) or restart (new started_at) means the backend changed under us.
  const initialStart = sessionStartedAt(version.data?.started_at)
  const updated =
    version.data !== undefined &&
    ((UI_VERSION !== 'dev' && version.data.version !== UI_VERSION) ||
      (initialStart !== undefined && version.data.started_at !== initialStart))

  return (
    <>
      <header className="strip">
        <div className="strip-top">
          <div className="mark">
            <span className="mark-name">EMHASS Lens</span>
            <span className="mark-version">{s?.version ?? UI_VERSION}</span>
          </div>
          <ModeSwitch mode={s?.emhass_mode} writable={s?.writable} driver={s?.driver} safeMode={s?.safe_mode} />
          <div className="lamps" aria-label="Status">
            {s && (
              <span title={driverSpec(s.driver).explain}>
                <LabelledLamp color={driverSpec(s.driver).color} text={`Driving EMHASS: ${driverSpec(s.driver).text}`} />
              </span>
            )}
            {s &&
              Object.entries(s.components).map(([name, comp]) => (
                <span key={name} title={comp.detail ?? undefined}>
                  <LabelledLamp color={statusColor(comp.status)} text={COMPONENT_NAMES[name] ?? name} />
                </span>
              ))}
            <StreamLamp />
            {problems === 0 ? (
              <span className="problem-count">No problems</span>
            ) : (
              <Link
                className="problem-count has-problems"
                to="/health?focus=problems"
                title={(s?.problems ?? []).map((p) => p.title).join('\n')}
              >
                {problems === 1 ? '1 problem' : `${problems} problems`}
              </Link>
            )}
          </div>
        </div>
        <nav className="tabs" aria-label="Main">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end}>
              {item.label}
              {item.tag && <span className="nav-tag">{item.tag}</span>}
            </NavLink>
          ))}
        </nav>
      </header>
      {status.isError && (
        <div className="banner" data-color="red" role="alert">
          <span>EMHASS Lens is not answering. The page keeps retrying.</span>
        </div>
      )}
      {updated && (
        <div className="banner" data-color="blue" role="status">
          <span>EMHASS Lens was updated or restarted.</span>
          <button type="button" onClick={reload}>
            Reload the page
          </button>
        </div>
      )}
      {s?.safe_mode && (
        <div className="banner" data-color="amber" role="status">
          <span>
            Safe mode is on: no jobs run and EMHASS is never called. Turn it off in the App's Configuration tab in Home
            Assistant.
          </span>
        </div>
      )}
      {s && s.settings_errors.length > 0 && (
        <div className="banner" data-color="red" role="alert">
          <span>
            The stored settings are invalid, so jobs are paused. Fix them in Settings:{' '}
            {s.settings_errors.map((e) => `${e.loc}: ${e.msg}`).join('; ')}
          </span>
        </div>
      )}
      {s && !s.writable && (
        <div className="banner" data-color="amber" role="status">
          <span>Read-only. {s.write_block_reason}</span>
        </div>
      )}
      <main>
        <Outlet />
      </main>
    </>
  )
}

// started_at seen when this page loaded; a later different value means the backend restarted.
let firstStartedAt: string | undefined
function sessionStartedAt(current: string | undefined): string | undefined {
  if (firstStartedAt === undefined && current !== undefined) firstStartedAt = current
  return firstStartedAt
}
