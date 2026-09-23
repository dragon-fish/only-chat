import { describe, expect, it } from 'vitest'
import { formatExtraValue, parseExtraValue } from '@/client/lib/extra-body'

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
