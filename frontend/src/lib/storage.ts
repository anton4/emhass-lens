// Storage card helpers: how full a database is against its budget, and words for a cleanup result.

import type { CleanupResult, DatabaseStorage } from '../api/types'

export type BudgetColor = 'green' | 'amber' | 'red'

/** Data in use as a share of the budget (can exceed 1). */
export function budgetShare(db: Pick<DatabaseStorage, 'data_bytes' | 'budget_bytes'>): number {
  if (db.budget_bytes <= 0) return 0
  return db.data_bytes / db.budget_bytes
}

/** Free pages as a share of the file. */
export function freeShare(db: Pick<DatabaseStorage, 'free_bytes' | 'data_bytes'>): number {
  const total = db.free_bytes + db.data_bytes
  return total > 0 ? db.free_bytes / total : 0
}

export function budgetColor(share: number): BudgetColor {
  if (share >= 1) return 'red'
  if (share >= 0.8) return 'amber'
  return 'green'
}

const LABELS: Record<string, string> = {
  log: 'log lines',
  run_artifact: 'run details',
  run: 'runs',
  price_slot: 'price slots',
  price_day: 'price days',
  forecast_snapshot: 'forecast snapshots',
  plan_snapshot: 'plans',
  measurement: 'measurements',
  costfun_result: 'cost-function plans',
  sofar_commit: 'inverter writes',
  sofar_press: 'inverter button presses',
  problem_event: 'problem records',
  market_session: 'market sessions',
  settings_revision: 'settings versions',
}

export function tableLabel(table: string): string {
  return LABELS[table] ?? table.replaceAll('_', ' ')
}

/** "41 230 log lines, 612 run details" from a {table: rows} map; zeros are left out. */
export function describeRemoved(removed: Record<string, number>): string {
  const parts = Object.entries(removed)
    .filter(([, n]) => n > 0)
    .map(([table, n]) => `${n.toLocaleString('en-US').replaceAll(',', ' ')} ${tableLabel(table)}`)
  return parts.length > 0 ? parts.join(', ') : 'nothing'
}

/** Rows the size budget cut, per database, as one line each. */
export function describeTrimmed(trimmed: CleanupResult['trimmed']): string[] {
  const out: string[] = []
  for (const [db, cuts] of Object.entries(trimmed)) {
    const text = describeRemoved(cuts)
    if (text !== 'nothing') out.push(`${db}: ${text}`)
  }
  return out
}
