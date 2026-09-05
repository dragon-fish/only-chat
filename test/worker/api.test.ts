import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

const json = (method: string, path: string, body?: unknown) =>
  exports.default.fetch(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }))

describe('REST api', () => {
  it('returns the default user', async () => {
    const res = await json('GET', '/api/me')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 1, settings: { plugins: {} } })
  })

  it('creates a provider without leaking the key, lists models, deletes', async () => {
    const created = await json('POST', '/api/providers', { name: 'A', protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1', api_key: 'sk-secret' })
    expect(created.status).toBe(201)
    const p = (await created.json()) as { id: number; has_key: boolean; api_key?: string }
    expect(p.has_key).toBe(true)
    expect(p.api_key).toBeUndefined()

    const m = await json('POST', `/api/providers/${p.id}/models`, { model_id: 'claude-x', display_name: 'Claude X', capabilities: { vision: true } })
    expect(m.status).toBe(201)
    const list = await (await json('GET', `/api/providers/${p.id}/models`)).json() as Array<{ model_id: string }>
    expect(list.map((x) => x.model_id)).toEqual(['claude-x'])

    const upd = await json('PUT', `/api/providers/${p.id}`, { name: 'B' })
    expect((await upd.json() as { name: string; has_key: boolean })).toMatchObject({ name: 'B', has_key: true })

    expect((await json('DELETE', `/api/providers/${p.id}`)).status).toBe(204)
    const after = await (await json('GET', '/api/providers')).json() as Array<{ id: number }>
    expect(after.find((x) => x.id === p.id)).toBeUndefined()
  })

  it('validates provider input', async () => {
    const res = await json('POST', '/api/providers', { name: '', protocol: 'nope', base_url: 'x' })
    expect(res.status).toBe(400)
  })

  it('uploads, dedupes and serves an attachment', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
    const check1 = await (await json('POST', '/api/attachments/check', { sha256: sha })).json() as { exists: boolean }
    expect(check1.exists).toBe(false)
    const up = await exports.default.fetch(new Request(`https://x/api/attachments/${sha}?w=2&h=2`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: bytes }))
    expect(up.status).toBe(201)
    const { attachment_id } = (await up.json()) as { attachment_id: number }
    const check2 = await (await json('POST', '/api/attachments/check', { sha256: sha })).json() as { exists: boolean; attachment_id: number }
    expect(check2).toEqual({ exists: true, attachment_id })
    const got = await exports.default.fetch(new Request(`https://x/api/attachments/${attachment_id}`))
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes)
  })

  it('rejects an upload whose hash does not match', async () => {
    const res = await exports.default.fetch(new Request(`https://x/api/attachments/${'0'.repeat(64)}`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: new Uint8Array([9]) }))
    expect(res.status).toBe(400)
  })

  it('lists sessions and messages', async () => {
    const res = await json('GET', '/api/sessions')
    expect(res.status).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
    expect((await json('GET', '/api/sessions/999999/messages')).status).toBe(404)
  })
})
