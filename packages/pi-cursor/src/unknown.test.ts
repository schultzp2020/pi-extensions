import { describe, expect, it } from 'vitest'

import { asJsonValue, getOwnNumber, getOwnString, isRecord, mapEntry } from './unknown.ts'

describe('isRecord', () => {
  it('accepts plain objects and rejects arrays/null/primitives', () => {
    expect(isRecord({ a: 1 })).toBeTruthy()
    expect(isRecord([])).toBeFalsy()
    expect(isRecord(null)).toBeFalsy()
    expect(isRecord('x')).toBeFalsy()
  })
})

describe('getOwnNumber / getOwnString', () => {
  it('reads matching own fields and returns undefined otherwise', () => {
    expect(getOwnNumber({ exp: 123 }, 'exp')).toBe(123)
    expect(getOwnNumber({ exp: '123' }, 'exp')).toBeUndefined()
    expect(getOwnString({ access: 'tok' }, 'access')).toBe('tok')
    expect(getOwnString(null, 'access')).toBeUndefined()
  })
})

describe('asJsonValue', () => {
  it('accepts JSON-shaped values and rejects non-JSON values', () => {
    expect(asJsonValue({ type: 'object', nested: [1, true, null] })).toEqual({
      type: 'object',
      nested: [1, true, null],
    })
    expect(asJsonValue({ skip: undefined, keep: 'ok' })).toEqual({ keep: 'ok' })
    expect(asJsonValue(() => 1)).toBeUndefined()
  })
})

describe('mapEntry', () => {
  it('reuses an existing entry and creates one when missing', () => {
    const map = new Map<string, number[]>()
    const first = mapEntry(map, 'a', () => [1])
    first.push(2)
    expect(mapEntry(map, 'a', () => [9])).toEqual([1, 2])
    expect(map.size).toBe(1)
  })
})
