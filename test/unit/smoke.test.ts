import { describe, expect, it } from 'vitest'
import { DEFAULT_USER_ID } from '@/shared/constants'

describe('unit smoke', () => {
  it('has the default user id', () => {
    expect(DEFAULT_USER_ID).toBe(1)
  })
})
