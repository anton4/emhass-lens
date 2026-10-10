import { describe, expect, it } from 'vitest'
import { budgetColor, budgetShare, describeRemoved, describeTrimmed, freeShare, tableLabel } from './storage'

describe('storage helpers', () => {
  it('measures use against the budget and colours it', () => {
    expect(budgetShare({ data_bytes: 50, budget_bytes: 100 })).toBe(0.5)
    expect(budgetShare({ data_bytes: 50, budget_bytes: 0 })).toBe(0)
    expect(budgetColor(0.5)).toBe('green')
    expect(budgetColor(0.8)).toBe('amber')
    expect(budgetColor(1.2)).toBe('red')
    expect(freeShare({ free_bytes: 25, data_bytes: 75 })).toBe(0.25)
    expect(freeShare({ free_bytes: 0, data_bytes: 0 })).toBe(0)
  })

  it('names tables and describes what a cleanup removed', () => {
    expect(tableLabel('run_artifact')).toBe('run details')
    expect(tableLabel('something_new')).toBe('something new')
    expect(describeRemoved({ log: 41230, run_artifact: 612, run: 0 })).toBe('41 230 log lines, 612 run details')
    expect(describeRemoved({ run: 0 })).toBe('nothing')
    expect(describeTrimmed({ 'runs.db': { log: 300 }, 'app.db': {} })).toEqual(['runs.db: 300 log lines'])
  })
})
