import { useState, type ReactNode } from 'react'
import { useSetControllerMode, type ControllerSection } from '../../api/actions'
import { ConfirmDialog } from '../ConfirmDialog'
import { LabelledLamp, type LampColor } from '../Lamp'

export interface ControllerMode {
  id: string
  text: string
}

type ModeSpec = (mode: string | null | undefined) => { color: LampColor; text: string; explain: string }

/** The head of an experimental controller page (Inverter, EV charger, Market): the title, the mode switch with the
 *  page's actions, one line on what the mode does, the Live warning, and the facts row. A mode change asks first,
 *  and going Live names the Home Assistant automation to turn off. */
export function ControllerHead({
  title,
  section,
  mode,
  modes,
  spec,
  automation,
  liveNotice,
  writable,
  actions,
  children,
}: {
  title: string
  section: ControllerSection
  mode: string | undefined
  modes: ControllerMode[]
  spec: ModeSpec
  /** The Home Assistant automation that must be off before Live. */
  automation: string
  /** Shown while the mode is Live. */
  liveNotice: ReactNode
  writable: boolean
  actions: ReactNode
  /** The facts row: In control, agreement and the page's own. */
  children: ReactNode
}) {
  const [target, setTarget] = useState<string | null>(null)
  const setMode = useSetControllerMode(section)
  const current = spec(mode)
  const chosen = target ? spec(target) : null
  const chosenText = modes.find((m) => m.id === target)?.text ?? ''
  const close = () => {
    setTarget(null)
    setMode.reset()
  }

  return (
    <>
      <div className="page-head controller-head">
        <div className="controller-title">
          <h1>{title}</h1>
          <span className="nav-tag">experimental</span>
        </div>
        <div className="toolbar">
          <div className="segmented mode-segmented" role="group" aria-label={`${title} control mode`} data-mode={mode}>
            {modes.map((m) => (
              <button
                key={m.id}
                type="button"
                aria-pressed={m.id === mode}
                disabled={!writable || setMode.isPending || m.id === mode}
                title={writable ? `Switch to ${m.text}` : 'Read-only: open EMHASS Lens from the Home Assistant sidebar'}
                onClick={() => setTarget(m.id)}
              >
                {m.text}
              </button>
            ))}
          </div>
          {actions}
        </div>
      </div>
      <p className="controller-explain">
        <LabelledLamp color={current.color} text={current.text} />
        <span className="muted">{current.explain}</span>
      </p>
      {mode === 'live' && (
        <div className="notice" data-color="amber" role="note">
          {liveNotice}
        </div>
      )}
      <dl className="facts facts-inline controller-facts">{children}</dl>

      <ConfirmDialog
        open={target !== null}
        title={`Switch ${title.toLowerCase()} control to ${chosenText}?`}
        onClose={close}
        actions={[
          {
            label: setMode.isPending ? 'Switching…' : `Switch to ${chosenText}`,
            kind: target === 'live' ? 'danger' : 'primary',
            onClick: () => target && setMode.mutate(target, { onSuccess: close }),
            disabled: setMode.isPending,
          },
        ]}
      >
        {chosen && <p>{chosen.explain}</p>}
        {target === 'live' && (
          <p>
            <strong>Turn the Home Assistant automation "{automation}" off first</strong>, or both will write.
          </p>
        )}
        <p className="cell-sub">
          The change is stored as a settings revision and can be reverted from Settings → History.
        </p>
        {setMode.error && (
          <div className="notice" data-color="red">
            {(setMode.error as Error).message}
          </div>
        )}
      </ConfirmDialog>
    </>
  )
}
