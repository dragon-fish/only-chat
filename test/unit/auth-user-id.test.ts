import { describe, expect, it } from 'vitest'
import { parseAuthUserId } from '@/server/plugins/auth/user-id'

describe('parseAuthUserId', () => {
  it.each([1, 42, Number.MAX_SAFE_INTEGER, '1', '42', '9007199254740991'])('accepts positive safe integer %s', value => {
    expect(parseAuthUserId(value)).toBe(Number(value))
  })
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '', ' ', ' 1', '1 ', '1.0', '1.5', '+1', '-1', '01', '1e2', '0x10', '9007199254740992'])('rejects malformed or unsafe ID %s', value => {
    expect(() => parseAuthUserId(value)).toThrow(TypeError)
  })
})
