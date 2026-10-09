import { useEffect, useId, useRef, type ReactNode } from 'react'

export interface DialogAction {
  label: string
  kind?: 'primary' | 'danger' | 'quiet'
  onClick: () => void
  disabled?: boolean
}

/** A modal confirmation built on <dialog>: focus is trapped, Escape and the Cancel button close it. */
export function ConfirmDialog({
  open,
  title,
  children,
  actions,
  onClose,
  cancelLabel = 'Cancel',
}: {
  open: boolean
  title: string
  children: ReactNode
  actions: DialogAction[]
  onClose: () => void
  cancelLabel?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog ref={ref} className="confirm" aria-labelledby={titleId} onClose={onClose} onCancel={onClose}>
      <h2 id={titleId}>{title}</h2>
      <div className="confirm-body">{children}</div>
      <div className="confirm-actions">
        <button type="button" onClick={onClose}>
          {cancelLabel}
        </button>
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className={action.kind}
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ))}
      </div>
    </dialog>
  )
}
