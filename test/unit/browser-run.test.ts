import { describe, expect, it } from 'vitest'
import { gatewayAllows } from '@/plugins/cloudflare-browser-run/server/gateway'
import { BrowserHandoffResultSchema, profileStorageKey, truncateLogs } from '@/plugins/cloudflare-browser-run/shared'
import { acquireSession, BrowserRateLimited, listSessions } from '@/plugins/cloudflare-browser-run/server/browser-api'

describe('browser gateway', () => {
  const props = { sessionId: 'sess-1' }
  it('forwards only a websocket connect to its own session', () => {
    expect(gatewayAllows(new URL('http://fake.host/v1/devtools/browser/sess-1'), 'websocket', props)).toBe(true)
    expect(gatewayAllows(new URL('http://fake.host/v1/devtools/browser/sess-1'), 'WebSocket', props)).toBe(true)
    expect(gatewayAllows(new URL('http://fake.host/v1/devtools/browser/sess-2'), 'websocket', props)).toBe(false)
    expect(gatewayAllows(new URL('http://fake.host/v1/devtools/browser/sess-1'), null, props)).toBe(false)
    expect(gatewayAllows(new URL('http://fake.host/v1/acquire?keep_alive=1'), 'websocket', props)).toBe(false)
    expect(gatewayAllows(new URL('http://fake.host/v1/sessions'), null, props)).toBe(false)
  })
})

describe('browser profiles', () => {
  it('keys login state by the chosen scope and stores nothing for ephemeral', () => {
    expect(profileStorageKey('ephemeral', { userId: 1, projectId: 4 })).toBeNull()
    expect(profileStorageKey('project', { userId: 1, projectId: 4 })).toBe('browser-profile:project:4')
    // A project profile without a Project has nowhere to live; it must not silently become user-wide.
    expect(profileStorageKey('project', { userId: 1, projectId: null })).toBeNull()
    expect(profileStorageKey('user', { userId: 1, projectId: 4 })).toBe('browser-profile:user:1')
  })
})

describe('browser_use logs', () => {
  it('keeps the newest lines when cutting to the model budget and says so', () => {
    const short = truncateLogs('a\nb', 64)
    expect(short).toEqual({ logs: 'a\nb', truncated: false })
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
    const cut = truncateLogs(lines, 256)
    expect(cut.truncated).toBe(true)
    expect(new TextEncoder().encode(cut.logs).byteLength).toBeLessThan(400)
    expect(cut.logs).toContain('line 199')
    expect(cut.logs).not.toContain('line 0\n')
  })
})

describe('handoff results', () => {
  it('accepts done and failed and marks a skip as one', () => {
    expect(BrowserHandoffResultSchema.parse({ status: 'done' })).toEqual({ status: 'done' })
    expect(BrowserHandoffResultSchema.parse({ status: 'failed', note: 'captcha' })).toEqual({ status: 'failed', note: 'captcha' })
    expect(() => BrowserHandoffResultSchema.parse({ status: 'maybe' })).toThrow()
  })
})

describe('browser control endpoints', () => {
  const binding = (handler: (url: string) => Response) => ({ fetch: async (input: string | URL | Request) => handler(String(input)) })

  it('acquires a session with the keep-alive and lists live ones', async () => {
    const seen: string[] = []
    const stub = binding((url) => {
      seen.push(url)
      if (url.includes('/v1/acquire')) return new Response(JSON.stringify({ sessionId: 'abc' }))
      return new Response(JSON.stringify({ sessions: [{ sessionId: 'abc' }] }))
    })
    expect(await acquireSession(stub, 600_000)).toEqual({ sessionId: 'abc' })
    expect(seen[0]).toBe('http://fake.host/v1/acquire?keep_alive=600000')
    expect(await listSessions(stub)).toEqual([{ sessionId: 'abc' }])
  })

  it('turns a 429 into a refusal the tool can pass on, with the wait when given', async () => {
    const limited = binding(() => new Response('too many', { status: 429, headers: { 'Retry-After': '20' } }))
    await expect(acquireSession(limited, 1)).rejects.toMatchObject({ name: 'BrowserRateLimited', retryAfterSeconds: 20 })
    const bare = binding(() => new Response('too many', { status: 429 }))
    await expect(acquireSession(bare, 1)).rejects.toBeInstanceOf(BrowserRateLimited)
    const broken = binding(() => new Response('boom', { status: 500 }))
    await expect(listSessions(broken)).rejects.toThrow(/500/)
  })
})
