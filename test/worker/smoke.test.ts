import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('worker smoke', () => {
  it('answers /api/health', async () => {
    const res = await exports.default.fetch(new Request('https://x/api/health'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
