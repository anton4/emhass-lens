import { useEffect, type RefObject } from 'react'

/** Calls `close` while `open` when the pointer goes down outside `wrap` or Escape is pressed. Dialogs a popover opens
 *  (a confirmation) live in the top layer, outside the wrapper, so pointers in them and Escape over them don't count. */
export function useDismiss(open: boolean, wrap: RefObject<HTMLElement | null>, close: () => void): void {
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (target?.closest('dialog')) return
      if (wrap.current && !wrap.current.contains(target)) close()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) close()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, wrap, close])
}
