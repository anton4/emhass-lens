import type { LampColor } from '../components/Lamp'

/** Component status from the API (ok | warning | error | unknown | disabled) as a lamp colour. */
export function statusColor(status: string): LampColor {
  switch (status) {
    case 'ok':
      return 'green'
    case 'warning':
      return 'amber'
    case 'error':
      return 'red'
    case 'info':
      return 'blue'
    default:
      return 'neutral'
  }
}
