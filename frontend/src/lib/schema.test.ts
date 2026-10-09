import { describe, expect, it } from 'vitest'
import { defaultFor, errorsByPath, fieldInfo, getPath, hasErrorsUnder, locatePath, setPath, type SchemaNode } from './schema'

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

describe('locatePath', () => {
  const schema: SchemaNode = {
    type: 'object',
    properties: {
      forecast: {
        type: 'object',
        title: 'Price forecast',
        properties: {
          ee: {
            type: 'object',
            title: 'eupowerprices.com',
            properties: { api_key: { type: 'string', title: 'API key' } },
          },
        },
      },
      emhass: {
        type: 'object',
        title: 'EMHASS',
        properties: {
          extra: { type: 'object', title: 'Extra parameters', additionalProperties: true, ui: { widget: 'json' } },
          mpc: { type: 'object', title: 'EmhassMpc', properties: { slot_offset_s: { type: 'integer' } } },
        },
      },
    },
  }

  it('names every level and points at the form row', () => {
    expect(locatePath(schema, 'forecast.ee.api_key')).toEqual({
      titles: ['Price forecast', 'eupowerprices.com', 'API key'],
      fieldPath: ['forecast', 'ee', 'api_key'],
    })
    // class-name titles fall back to the key, like the form does
    expect(locatePath(schema, 'emhass.mpc.slot_offset_s').titles).toEqual(['EMHASS', 'MPC', 'Slot offset s'])
  })

  it('stops at a JSON field and keeps unknown keys as they are', () => {
    expect(locatePath(schema, 'emhass.extra.weight_battery')).toEqual({
      titles: ['EMHASS', 'Extra parameters', 'weight_battery'],
      fieldPath: ['emhass', 'extra'],
    })
    expect(locatePath(schema, 'gone.thing')).toEqual({ titles: ['gone', 'thing'], fieldPath: [] })
  })
})
