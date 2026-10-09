import { describe, expect, it } from 'vitest'
import { defaultFor, errorsByPath, fieldInfo, getPath, hasErrorsUnder, setPath, type SchemaNode } from './schema'

describe('fieldInfo', () => {
  it('unwraps anyOf with null into a nullable field', () => {
    const node: SchemaNode = {
      anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }],
      default: null,
      title: 'Day peak',
      ui: { unit: '€/kWh' },
    }
    const info = fieldInfo('day_peak', node)
    expect(info.kind).toBe('number')
    expect(info.nullable).toBe(true)
    expect(info.node.minimum).toBe(0)
    expect(info.title).toBe('Day peak')
    expect(info.ui.unit).toBe('€/kWh')
  })

  it('detects enums, objects, lists and dicts', () => {
    expect(fieldInfo('mode', { type: 'string', enum: ['off', 'live'] }).kind).toBe('enum')
    expect(fieldInfo('emhass', { type: 'object', properties: { a: { type: 'string' } } }).kind).toBe('object')
    expect(fieldInfo('loads', { type: 'array', items: { type: 'object', properties: {} } }).kind).toBe('list')
    expect(fieldInfo('extra', { type: 'object', additionalProperties: true, ui: { widget: 'json' } }).kind).toBe(
      'dict',
    )
    expect(fieldInfo('slot_offset_s', { type: 'integer' }).title).toBe('Slot offset s')
    // class-name titles from nested models fall back to the key
    expect(fieldInfo('mpc', { type: 'object', title: 'EmhassMpc', properties: {} }).title).toBe('MPC')
    expect(fieldInfo('emhass', { type: 'object', title: 'EMHASS', properties: {} }).title).toBe('EMHASS')
    expect(fieldInfo('timeouts', { type: 'object', title: 'EmhassTimeouts', properties: {} }).title).toBe('Timeouts')
  })
})

describe('paths', () => {
  it('gets and sets immutably, including list indices', () => {
    const doc = { inputs: { loads: [{ name: 'EV' }] } }
    const next = setPath(doc, ['inputs', 'loads', 0, 'name'], 'Car')
    expect(getPath(next, ['inputs', 'loads', 0, 'name'])).toBe('Car')
    expect(getPath(doc, ['inputs', 'loads', 0, 'name'])).toBe('EV')
    expect(getPath(doc, ['missing', 'x'])).toBeUndefined()
  })

  it('builds defaults for new list items', () => {
    const item: SchemaNode = {
      type: 'object',
      properties: {
        name: { type: 'string', default: 'EV' },
        power: { type: 'integer', default: 11000 },
        peak: { anyOf: [{ type: 'number' }, { type: 'null' }], default: null },
      },
    }
    expect(defaultFor(item)).toEqual({ name: 'EV', power: 11000, peak: null })
  })

  it('groups errors and finds nested ones', () => {
    const errors = errorsByPath([
      { loc: 'prices.tariff.vat_pct', msg: 'too big' },
      { loc: 'inputs.deferrable_loads.0.name', msg: 'required' },
    ])
    expect(errors.get('prices.tariff.vat_pct')).toEqual(['too big'])
    expect(hasErrorsUnder(errors, 'prices')).toBe(true)
    expect(hasErrorsUnder(errors, 'inputs.deferrable_loads')).toBe(true)
    expect(hasErrorsUnder(errors, 'emhass')).toBe(false)
  })
})
