// The plan in one line, for the top of the Plan page: what the battery does from now until that changes, and where
// its state of charge goes meanwhile ("Discharging the battery until 21:30, then idle · SOC 94 % → 38 %").

import type { PlanRow } from '../api/types'
import { formatSlot } from './format'
import { num, rowTime, socOf, SLOT_S } from './plan'

type Action = 'charge' | 'discharge' | 'idle'

/** Below this the battery counts as idle: EMHASS plans often carry a few watts of numerical noise. */
const IDLE_W = 100

function actionOf(row: PlanRow | undefined): Action | null {
  const p = num(row, 'P_batt')
  if (p === null) return null
  return p > IDLE_W ? 'discharge' : p < -IDLE_W ? 'charge' : 'idle'
}

const NOW_TEXT: Record<Action, string> = {
  charge: 'Charging the battery',
  discharge: 'Discharging the battery',
  idle: 'Battery idle',
}

const THEN_TEXT: Record<Action, string> = { charge: 'then charging', discharge: 'then discharging', idle: 'then idle' }

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)} %`
}

export function planSummary(rows: PlanRow[], nowS: number, timeZone?: string): string | null {
  const start = rows.findIndex((r) => {
    const t = rowTime(r)
    return t !== null && t + SLOT_S > nowS
  })
  if (start < 0) return null
  const action = actionOf(rows[start])
  if (action === null) return null
  let end = start
  while (end + 1 < rows.length && actionOf(rows[end + 1]) === action) end++
  const next = rows[end + 1]
  const nextT = next ? rowTime(next) : null
  const now = new Date(nowS * 1000)
  const until =
    nextT !== null
      ? `until ${formatSlot(new Date(nextT * 1000).toISOString(), now, timeZone)}`
      : 'to the end of the plan'

  const nextAction = actionOf(next)
  let line = `${NOW_TEXT[action]} ${until}`
  if (nextAction && nextAction !== action) line += `, ${THEN_TEXT[nextAction]}`
  const from = socOf(rows[start - 1]) ?? socOf(rows[start])
  const to = socOf(rows[end])
  if (from === null || to === null) return line
  const same = action === 'idle' || Math.round(from * 100) === Math.round(to * 100)
  return `${line} · SOC ${same ? pct(to) : `${pct(from)} → ${pct(to)}`}`
}
