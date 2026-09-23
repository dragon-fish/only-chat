import { describe, expect, it } from 'vitest'
import { buildExtraBody, extraBodyRows, formatExtraValue, parseExtraValue } from '@/client/lib/extra-body'

describe('extra body value text', () => {
  it('reads JSON literals as JSON and anything else as a string', () => {
    expect(parseExtraValue('false')).toBe(false)
    expect(parseExtraValue('12')).toBe(12)
    expect(parseExtraValue('{"seed":7}')).toEqual({ seed: 7 })
    expect(parseExtraValue('2K')).toBe('2K')
    expect(parseExtraValue('"12"')).toBe('12')
  })

  it('writes every value back to text that parses to the same value', () => {
    for (const value of [false, 12, { seed: 7 }, '2K', '12', 'false', '']) {
      expect(parseExtraValue(formatExtraValue(value))).toEqual(value)
    }
  })
})

describe('buildExtraBody', () => {
  it('builds typed entries, skipping blank rows, and round-trips through rows', () => {
    const built = buildExtraBody([{ key: ' watermark ', value: 'false' }, { key: '', value: '' }, { key: 'size', value: '2K' }])
    expect(built).toEqual({ body: { watermark: false, size: '2K' } })
    if (!('body' in built)) throw new Error('expected a body')
    expect(buildExtraBody(extraBodyRows(built.body))).toEqual(built)
  })

  it('reports a row it cannot send instead of dropping it', () => {
    expect(buildExtraBody([{ key: 'seed', value: '1' }, { key: 'seed', value: '2' }])).toHaveProperty('error')
    expect(buildExtraBody([{ key: '', value: 'false' }])).toHaveProperty('error')
    expect(buildExtraBody([{ key: 'prompt', value: 'x' }])).toHaveProperty('error')
  })
})

