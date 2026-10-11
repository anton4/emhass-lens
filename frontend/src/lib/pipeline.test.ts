import { describe, expect, it } from 'vitest'
import { buildPipeline } from './pipeline'

// Run 985 (EMHASS MPC, 10 Oct): two cost functions compared, then the live call failed after a 91 s solve
const RUN_985 = {
  run: {
    started_at: '2026-10-10T14:13:00.006+00:00',
    finished_at: '2026-10-10T14:15:26.885+00:00',
    duration_ms: 146879,
  },
  costfuns: [
    { costfun: 'cost', live: false, optim_status: 'ok', duration_ms: 43732, generated_at: '2026-10-10T14:13:43Z' },
    {
      costfun: 'self-consumption',
      live: false,
      optim_status: 'ok',
      duration_ms: 7689,
      generated_at: '2026-10-10T14:13:51Z',
    },
  ],
  response: { duration_ms: 95372, error: null },
  lastRun: {
    status: 'error',
    timestamp: '2026-10-10T14:15:26Z',
    action: 'naive-mpc-optim',
    stage_times: {
      pv_forecast: 0.0112,
      load_forecast: 2.9555,
      price_prep: 0.0641,
      'optim_solve.build': 0.0141,
      'optim_solve.solve': 91.0214,
      'optim_solve.extract': 0.0059,
      optim_solve: 91.044,
    },
    duration_total_seconds: 91.1202,
    error_message: null,
  },
  liveCostfun: 'profit',
}

describe('buildPipeline', () => {
  it('lays out run 985: build, two cost functions, the failed live call with EMHASS stages', () => {
    const p = buildPipeline(RUN_985)
    expect(p.totalMs).toBe(146879)
    expect(p.solveMs).toBeCloseTo(91021, -1)
    expect(p.steps.map((s) => s.label)).toEqual([
      'Build payload',
      'Cost function · cost',
      'Cost function · self-consumption',
      'EMHASS naive-mpc-optim (profit)',
    ])
    const [build, cost, self, live] = p.steps
    expect(build?.ms).toBe(0) // the first call ended at :43 after 43.7 s, so it started with the run
    expect(cost?.ms).toBe(43732)
    expect(self!.startMs).toBeGreaterThanOrEqual(cost!.startMs + cost!.ms)
    expect(live?.status).toBe('error')
    expect(live?.note).toBe('EMHASS reported an error')
    expect(live!.startMs + live!.ms).toBeLessThanOrEqual(p.totalMs)
    const stages = live?.children ?? []
    expect(stages.map((s) => s.label)).toEqual(['PV forecast', 'Load forecast', 'Price prep', 'Optimisation'])
    expect(stages[3]?.note).toBe('build 14 ms · solve 1 min 31 s · extract 6 ms')
    expect(stages[3]!.startMs + stages[3]!.ms).toBeCloseTo(live!.startMs + live!.ms, -1)
  })

  it('places calls by when they were sent, and shows what came after the last one', () => {
    const p = buildPipeline({
      run: { started_at: '2026-10-11T08:00:00.000Z', duration_ms: 12000 },
      costfuns: [
        { costfun: 'cost', live: false, sent_at: '2026-10-11T08:00:00.400Z', duration_ms: 3000, problem: 'no plan' },
      ],
      response: { sent_at: '2026-10-11T08:00:03.500Z', duration_ms: 7000 },
      lastRun: { status: 'ok', timestamp: '2026-10-11T08:00:10Z' },
    })
    expect(p.steps.map((s) => [s.key, s.startMs, s.ms, s.status])).toEqual([
      ['build', 0, 400, 'ok'],
      ['costfun:cost', 400, 3000, 'warn'],
      ['live', 3500, 7000, 'ok'],
      ['after', 10500, 1500, 'neutral'],
    ])
    expect(p.steps[1]?.note).toBe('no plan')
  })

  it('is just the build for a run that never called EMHASS', () => {
    const p = buildPipeline({ run: { started_at: '2026-10-11T08:00:00Z', duration_ms: 350 }, costfuns: [] })
    expect(p.steps).toEqual([{ key: 'build', label: 'Build payload', startMs: 0, ms: 350, status: 'ok' }])
    expect(p.solveMs).toBeNull()
  })

  it('marks a request that failed outright', () => {
    const p = buildPipeline({
      run: { started_at: '2026-10-11T08:00:00Z', duration_ms: 30000 },
      costfuns: [],
      response: { duration_ms: 30000, error: 'Timed out after 30 s' },
    })
    expect(p.steps[1]).toMatchObject({ key: 'live', status: 'error', note: 'Timed out after 30 s', startMs: 0 })
  })
})
