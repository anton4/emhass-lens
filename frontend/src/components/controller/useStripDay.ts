import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router'
import { clampDay, stripDays, todayKey } from '../../lib/days'

/** The day a controller page's strip shows, from `?day=` (today when it is missing or out of range): up to a week
 *  back, and `ahead` days after today. `setDay` keeps today out of the URL. */
export function useStripDay(timeZone: string | undefined, now: Date, ahead = 0) {
  const [params, setParams] = useSearchParams()
  const today = todayKey(timeZone, now)
  const days = useMemo(() => stripDays(today, 7, ahead), [today, ahead])
  const day = clampDay(params.get('day'), days, today)
  const setDay = useCallback(
    (next: string) =>
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev)
          if (next === today) p.delete('day')
          else p.set('day', next)
          return p
        },
        { replace: true },
      ),
    [setParams, today],
  )
  return { day, days, today, setDay }
}
