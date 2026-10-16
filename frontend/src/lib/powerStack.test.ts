import { describe, expect, it } from 'vitest'
import { powerStack, stackExtent } from './powerStack'

describe('the Power chart stack', () => {
  // three slots: PV and the battery discharging in a sell, the battery charging at night, then no data
  const pv = [3270, 0, null]
  const battery = [10620, -15000, null] // EMHASS's sign: + discharge
  const load = [1040, 400, null]
  const deferrable = [0, 11000, null]

  it('stacks PV and the battery discharging above zero, the house, the battery charging and the EV below', () => {
    const layers = powerStack({ pv, battery, load, deferrable })
    expect(layers.map((l) => [l.key, l.on])).toEqual([
      ['pv', null],
      ['discharge', 'pv'],
      ['load', null],
      ['charge', 'load'],
      ['deferrable', 'charge'],
    ])
    const edge = Object.fromEntries(layers.map((l) => [l.key, l.edge]))
    expect(edge.pv).toEqual([3270, 0, null])
    expect(edge.discharge).toEqual([13890, 0, null])
    expect(edge.load).toEqual([-1040, -400, null])
    expect(edge.charge).toEqual([-1040, -15400, null])
    expect(edge.deferrable).toEqual([-1040, -26400, null])
    // each layer keeps its own power for the popup
    expect(layers.find((l) => l.key === 'charge')?.own).toEqual([0, 15000, null])
  })

  it('counts a flow without a value as zero where others have one, and leaves out flows not given', () => {
    const layers = powerStack({ pv: [null, 500], load: [700, null] })
    expect(layers.map((l) => l.key)).toEqual(['pv', 'load'])
    expect(layers[0]?.edge).toEqual([0, 500])
    expect(layers[1]?.edge).toEqual([-700, 0])
  })

  it('gives the y-axis the stacks, always with zero in it', () => {
    expect(stackExtent(powerStack({ pv, battery, load, deferrable }))).toEqual([-26400, 13890])
    expect(stackExtent(powerStack({ pv: [200] }))).toEqual([0, 200])
    expect(stackExtent([])).toBeNull()
  })
})

describe('powerStack with the grid as a layer', () => {
  it('stacks the import on top and the export at the bottom, so both sides add up', () => {
    const layers = powerStack({ pv: [3000, 0], load: [1000, 1500], grid: [-2000, 1500] })
    expect(layers.map((l) => l.key)).toEqual(['pv', 'import', 'load', 'export'])
    const edge = (key: string) => layers.find((l) => l.key === key)?.edge
    // exporting 2 kW: 3 kW in, 1 kW to the house and 2 kW out; importing 1.5 kW: it all goes to the house
    expect(edge('import')).toEqual([3000, 1500])
    expect(edge('export')).toEqual([-3000, -1500])
  })
})
