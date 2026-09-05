import { describe, expect, it } from 'vitest'
import { sha256Hex } from '@/client/lib/image-prep'

describe('sha256Hex', () => {
  it('hashes bytes to lowercase hex', async () => {
    expect(await sha256Hex(new Uint8Array([1, 2, 3, 4]).buffer)).toBe('9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a')
  })
})
