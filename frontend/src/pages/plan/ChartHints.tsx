import { useMediaQuery } from '../../components/useMediaQuery'
import { adaptiveStep, type KeyStep } from '../../lib/chartKeys'
import { spanLabel } from '../../lib/chartTime'

const stepText = (s: number) => (s === 900 ? 'a quarter-hour' : s === 3600 ? 'an hour' : spanLabel(s))

/** What the Timeline's charts answer to: the pointer, the wheel, a drag and the keys on a desktop; a finger and two on
 *  a phone. The arrow keys' step follows the window shown. */
export function ChartHints({ windowS, step, touch: phone = false }: { windowS: number; step?: KeyStep; touch?: boolean }) {
  const coarse = useMediaQuery('(pointer: coarse)')
  const touch = phone || coarse
  const keys = step ?? adaptiveStep(windowS)
  if (touch) {
    return (
      <p className="chart-hints">
        <span>Drag along a chart to read it</span>
        <span>Pinch to zoom</span>
        <span>Two fingers to move</span>
        <span>Drag the overview's box to jump</span>
      </p>
    )
  }
  return (
    <p className="chart-hints">
      <span>
        <kbd>point</kbd> every value at that moment
      </span>
      <span>
        <kbd>scroll</kbd> zoom at the pointer
      </span>
      <span>
        <kbd>drag</kbd> zoom into a range
      </span>
      <span>
        <kbd>shift</kbd> + <kbd>drag</kbd> or sideways scroll: move
      </span>
      <span>
        <kbd>double-click</kbd> back to now
      </span>
      <span>
        <kbd>←</kbd> <kbd>→</kbd> {stepText(keys.step)}, with <kbd>shift</kbd> {stepText(keys.big)} (the Power chart
        takes the keys)
      </span>
    </p>
  )
}
