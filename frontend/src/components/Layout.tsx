import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { useRunJob } from '../api/actions'
import { useStatus, useVersion } from '../api/queries'
import type { StatusInfo } from '../api/types'
import { NAV_GROUPS, pageForKey } from '../lib/nav'
import { CommandPalette, type PaletteAction } from './CommandPalette'
import { Icon } from './Icon'
import { Lamp } from './Lamp'
import { StatusMenu } from './StatusMenu'

const UI_VERSION = import.meta.env.VITE_APP_VERSION || 'dev'
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

function reload() {
  const url = new URL(window.location.href)
  url.searchParams.set('v', String(Date.now()))
  window.location.replace(url.toString())
}

/** Typing in a field must not trigger the single-letter shortcuts. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

interface Banner {
  key: string
  color: 'red' | 'amber' | 'blue'
  content: ReactNode
}

/** One banner at a time, the most serious first; the rest wait behind "+N more". */
function BannerSlot({ banners }: { banners: Banner[] }) {
  const [expanded, setExpanded] = useState(false)
  if (banners.length === 0) return null
  const shown = expanded ? banners : banners.slice(0, 1)
  return (
    <div className="banners">
      {shown.map((b, i) => (
        <div key={b.key} className="banner" data-color={b.color} role={b.color === 'red' ? 'alert' : 'status'}>
          <Lamp color={b.color} />
          <div className="banner-text">{b.content}</div>
          {i === 0 && banners.length > 1 && (
            <button
              type="button"
              className="banner-more"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Show fewer' : `+${banners.length - 1} more`}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

function UpdateLink({ status }: { status: StatusInfo | undefined }) {
  const update = status?.update
  if (update?.update_available && update.version_latest) {
    return (
      <a
        className="update-chip"
        href={update.addon_path ?? '/hassio/store'}
        target="_top"
        rel="noopener"
        title={`Home Assistant can install EMHASS Lens ${update.version_latest}; opens the App's page`}
      >
        <Lamp color="blue" />
        Update to {update.version_latest}
      </a>
    )
  }
  if (update?.released_version) {
    return (
      <a
        className="update-chip"
        href={update.store_path ?? '/hassio/store'}
        target="_top"
        rel="noopener"
        title={`EMHASS Lens ${update.released_version} is released, but Home Assistant hasn't picked it up yet: in the App store use ⋮ → Check for updates, then update EMHASS Lens`}
      >
        <span>{update.released_version} released</span>
        <span className="update-chip-action">Check for updates</span>
      </a>
    )
  }
  return null
}

/** The pages as tabs in their groups. On a narrow screen they scroll sideways, and the current one is kept in view. */
function Tabs({ status }: { status: StatusInfo | undefined }) {
  const problems = status?.problems ?? []
  const severe = problems.some((p) => p.severity === 'error')
  const location = useLocation()
  const nav = useRef<HTMLElement>(null)

  useEffect(() => {
    const strip = nav.current
    const current = strip?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!strip || !current) return
    const left = current.offsetLeft - strip.offsetLeft
    if (left < strip.scrollLeft || left + current.offsetWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = left - (strip.clientWidth - current.offsetWidth) / 2
    }
  }, [location.pathname])

  return (
    <nav aria-label="Main" className="page-tabs" ref={nav}>
      {NAV_GROUPS.map((group) => (
        <div key={group.label} className="page-tab-group" role="group" aria-label={group.label}>
          {group.pages.map((page) => (
            <NavLink
              key={page.to}
              to={page.to}
              end={page.to === '/'}
              className="page-tab"
              title={page.key ? `${page.label} (g then ${page.key})` : undefined}
            >
              {page.label}
              {page.experimental && <span className="nav-tag">exp</span>}
              {page.to === '/health' && problems.length > 0 && (
                <span
                  className="nav-count"
                  data-color={severe ? 'red' : 'amber'}
                  title={problems.map((p) => p.title).join('\n')}
                >
                  <Lamp color={severe ? 'red' : 'amber'} />
                  {problems.length}
                  <span className="visually-hidden">{problems.length === 1 ? ' problem' : ' problems'}</span>
                </span>
              )}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  )
}

function ProblemsChip({ status }: { status: StatusInfo }) {
  const problems = status.problems
  if (problems.length === 0) return null
  const severe = problems.some((p) => p.severity === 'error')
  const text = problems.length === 1 ? '1 problem' : `${problems.length} problems`
  return (
    <Link
      className="problems-chip"
      data-color={severe ? 'red' : 'amber'}
      to="/health?focus=problems"
      title={problems.map((p) => p.title).join('\n')}
      aria-label={text}
    >
      <Lamp color={severe ? 'red' : 'amber'} />
      <span className="problems-count">{problems.length}</span>
      <span className="problems-word">{problems.length === 1 ? 'problem' : 'problems'}</span>
    </Link>
  )
}

export function Layout() {
  const status = useStatus()
  const version = useVersion()
  const s = status.data
  const navigate = useNavigate()
  const runJob = useRunJob()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const pendingG = useRef<number | null>(null)
  const shownVersion = s?.version ?? UI_VERSION

  // An App update (different version) or restart (new started_at) means the backend changed under us.
  const initialStart = sessionStartedAt(version.data?.started_at)
  const updated =
    version.data !== undefined &&
    ((UI_VERSION !== 'dev' && version.data.version !== UI_VERSION) ||
      (initialStart !== undefined && version.data.started_at !== initialStart))

  const canRun = Boolean(s?.writable && !s.safe_mode)
  const runWhy = s?.safe_mode
    ? 'Safe mode is on: EMHASS is never called'
    : s && !s.writable
      ? `Read-only: ${s.write_block_reason ?? 'open EMHASS Lens from the Home Assistant sidebar'}`
      : 'Build the MPC payload now and run it as the EMHASS mode says (live, dry run or shadow)'
  const runMpc = () => {
    setRunError(null)
    runJob.mutate('emhass.mpc', {
      onSuccess: (result) => {
        navigate(result.run_id ? `/runs/${result.run_id}` : '/runs?job=emhass.mpc')
      },
      onError: (error) => setRunError((error as Error).message),
    })
  }

  // ⌘K / Ctrl+K opens the palette anywhere; "g" then a letter opens a page
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(true)
        return
      }
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTyping(event.target) ||
        document.querySelector('dialog[open]')
      )
        return
      if (pendingG.current !== null) {
        window.clearTimeout(pendingG.current)
        pendingG.current = null
        const target = pageForKey(event.key)
        if (target) {
          event.preventDefault()
          navigate(target.to)
        }
        return
      }
      if (event.key === 'g') pendingG.current = window.setTimeout(() => (pendingG.current = null), 1200)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  const actions: PaletteAction[] = canRun ? [{ label: 'Run MPC now', run: runMpc }] : []

  const banners: Banner[] = []
  if (status.isError) {
    banners.push({ key: 'down', color: 'red', content: 'EMHASS Lens is not answering. The page keeps retrying.' })
  }
  if (s && s.settings_errors.length > 0) {
    banners.push({
      key: 'settings',
      color: 'red',
      content: (
        <>
          The stored settings are invalid, so jobs are paused. Fix them in <Link to="/settings">Settings</Link>:{' '}
          {s.settings_errors.map((e) => `${e.loc}: ${e.msg}`).join('; ')}
        </>
      ),
    })
  }
  if (runError) {
    banners.push({
      key: 'run',
      color: 'red',
      content: (
        <>
          Couldn't start MPC: {runError}{' '}
          <button type="button" className="quiet" onClick={() => setRunError(null)}>
            Dismiss
          </button>
        </>
      ),
    })
  }
  if (updated) {
    banners.push({
      key: 'updated',
      color: 'blue',
      content: (
        <>
          EMHASS Lens was updated or restarted.{' '}
          <button type="button" className="quiet" onClick={reload}>
            Reload the page
          </button>
        </>
      ),
    })
  }
  if (s?.safe_mode) {
    banners.push({
      key: 'safe',
      color: 'amber',
      content:
        "Safe mode is on: no jobs run and EMHASS is never called. Turn it off in the App's Configuration tab in Home Assistant.",
    })
  }
  if (s && !s.writable) {
    banners.push({ key: 'readonly', color: 'amber', content: `Read-only. ${s.write_block_reason ?? ''}` })
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-row">
          <Link to="/" className="brand">
            <span className="brand-mark">
              <Icon name="brand" size={20} />
            </span>
            <span className="brand-name">EMHASS Lens</span>
            <span className="brand-version">{shownVersion === 'dev' ? 'dev' : `v${shownVersion}`}</span>
          </Link>
          <UpdateLink status={s} />
          <div className="topbar-status">
            <button
              type="button"
              className="palette-button"
              aria-label="Search or jump to"
              onClick={() => setPaletteOpen(true)}
            >
              <Icon name="search" size={14} />
              <span className="palette-button-text">Search or jump to…</span>
              <kbd>{IS_MAC ? '⌘K' : 'Ctrl K'}</kbd>
            </button>
            {s && <StatusMenu status={s} />}
            {s && <ProblemsChip status={s} />}
            <button
              type="button"
              className="primary run-mpc"
              disabled={!canRun || runJob.isPending}
              title={runWhy}
              onClick={runMpc}
            >
              <Icon name="play" size={11} />
              <span className="run-mpc-text">{runJob.isPending ? 'Starting…' : 'Run MPC now'}</span>
            </button>
          </div>
        </div>
        <Tabs status={s} />
      </header>
      <BannerSlot banners={banners} />
      <main>
        <Outlet />
      </main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} actions={actions} />
    </div>
  )
}

// started_at seen when this page loaded; a later different value means the backend restarted.
let firstStartedAt: string | undefined
function sessionStartedAt(current: string | undefined): string | undefined {
  if (firstStartedAt === undefined && current !== undefined) firstStartedAt = current
  return firstStartedAt
}
