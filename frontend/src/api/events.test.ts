import { describe, expect, it } from 'vitest'
import { familiesForJob } from './events'

describe('familiesForJob', () => {
  it('refreshes the plan and outputs after publishing and MPC runs', () => {
    expect(familiesForJob('emhass.publish')).toEqual(['plan', 'outputs'])
    expect(familiesForJob('emhass.mpc')).toContain('plan')
  })
  it('refreshes settings after take over / hand back and problems after ML jobs', () => {
    expect(familiesForJob('driver.take_over')).toContain('settings')
    expect(familiesForJob('ml.fit')).toEqual(['problems'])
    expect(familiesForJob('nordpool.poll')).toEqual(['prices'])
  })
})
