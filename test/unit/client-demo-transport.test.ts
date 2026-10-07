import { describe, expect, it, vi } from 'vitest'
import { createFakeFetch } from '@/client/demo/fake-fetch'
import { createFakeWebSocket } from '@/client/demo/fake-socket'

const ORIGIN = 'https://demo.example'

describe('demo transport', () => {
  it('never lets an unscripted API request reach the network', async () => {
    // The demo shares an origin with the real app: a request let through would carry the
    // browser's real session cookie.
    const realFetch = vi.fn(async () => new Response('real'))
    const fake = createFakeFetch([{ method: 'GET', path: /^\/api\/me$/, handle: () => ({ id: 2 }) }], realFetch, ORIGIN)

    const unmatched = await fake('/api/conversations')
    const wrongMethod = await fake(new URL('/api/me', ORIGIN), { method: 'DELETE' })
    const absolute = await fake(new URL('/api/me', ORIGIN))

    expect(unmatched.status).toBe(501)
    expect(wrongMethod.status).toBe(501)
    expect(await absolute.json()).toEqual({ id: 2 })
    expect(realFetch).not.toHaveBeenCalled()
  })

  it('passes non-API requests through untouched', async () => {
    const realFetch = vi.fn(async () => new Response('asset'))
    const fake = createFakeFetch([], realFetch, ORIGIN)

    await fake('/assets/app.js')
    await fake('https://elsewhere.example/api/me')

    expect(realFetch).toHaveBeenCalledTimes(2)
  })

  it('refuses a socket to anything but /ws', () => {
    const FakeWebSocket = createFakeWebSocket({ receive: () => {}, attach: () => {} }, ORIGIN)

    expect(() => new FakeWebSocket('wss://demo.example/other')).toThrow()
    expect(() => new FakeWebSocket('wss://evil.example/ws')).toThrow()
    expect(() => new FakeWebSocket('wss://demo.example/ws')).not.toThrow()
  })
})
