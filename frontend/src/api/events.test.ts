import { describe, expect, it } from 'vitest'
import { familiesForJob } from './events'

describe('familiesForJob', () => {
  it('refreshes the plan and outputs after publishing and MPC runs', () => {
    expect(familiesForJob('emhass.publish')).toEqual(['plan', 'outputs'])
    expect(familiesForJob('emhass.mpc')).toContain('plan')
    expect(familiesForJob('emhass.mpc')).toContain('costfun')
    expect(familiesForJob('emhass.costfun_compare')).toEqual(['plan', 'costfun', 'emhass', 'outputs'])
  })
  it('refreshes settings after take over / hand back and problems after ML jobs', () => {
    expect(familiesForJob('driver.take_over')).toContain('settings')
    expect(familiesForJob('ml.fit')).toEqual(['problems'])
    expect(familiesForJob('nordpool.poll')).toEqual(['prices'])
  })
  it('refreshes the plan (and its history) after measurement runs', () => {
    expect(familiesForJob('measure.sample')).toEqual(['plan'])
    expect(familiesForJob('measure.backfill')).toEqual(['plan'])
  })
  it('refreshes the inverter status after decide and compare runs', () => {
    expect(familiesForJob('inverter.decide')).toEqual(['inverter'])
    expect(familiesForJob('inverter.compare')).toEqual(['inverter'])
  })
  it('refreshes the charger status after its runs', () => {
    expect(familiesForJob('charger.decide')).toEqual(['charger'])
    expect(familiesForJob('charger.compare')).toEqual(['charger'])
  })
  it('refreshes the market status after its runs and the driver after a resume', () => {
    expect(familiesForJob('market.reconcile')).toEqual(['market'])
    expect(familiesForJob('external.resume')).toEqual(['emhass', 'inverter'])
  })
})
