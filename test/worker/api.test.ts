import { env, exports } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { attachmentProviderFiles, attachments } from '@/server/db/schema'
import { createProject } from '@/server/plugins/hub/projects'
import { DEFAULT_USER_ID } from '@/shared/constants'

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

  it('serves a generated attachment through the same authenticated route', async () => {
    // Assistant images reuse the upload route's reader; no public or unauthenticated path exists.
    const db = createDb(env.DB)
    const bytes = new Uint8Array([137, 80, 78, 71, 71, 69, 78])
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
    const key = `${DEFAULT_USER_ID}/${sha.slice(0, 2)}/${sha}`
    await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: 'image/png' } })
    const [row] = await db.insert(attachments).values({
      user_id: DEFAULT_USER_ID, sha256: sha, mime: 'image/png', size: bytes.byteLength,
      width: null, height: null, r2_key: key, origin: 'generated', created_at: 0,
    }).onConflictDoUpdate({ target: [attachments.user_id, attachments.sha256], set: { r2_key: key } }).returning()

    const got = await exports.default.fetch(new Request(`https://x/api/attachments/${row!.id}`))
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

  it('lists projects for the current user, read-only', async () => {
    const db = createDb(env.DB)
    const mine = await createProject(db, { user_id: DEFAULT_USER_ID, name: 'Mine', system_prompt: 'sys' })
    const list = await (await json('GET', '/api/projects')).json() as Array<{ id: number; name: string }>
    expect(list.find((p) => p.id === mine.id)).toMatchObject({ name: 'Mine', system_prompt: 'sys' })
    expect((await json('POST', '/api/projects', { name: 'nope' })).status).toBe(404)
  })

  it('rejects a duplicate model_id with 409 and preserves the existing edit', async () => {
    const created = await json('POST', '/api/providers', { name: 'C', protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1' })
    const p = (await created.json()) as { id: number }
    const m = await json('POST', `/api/providers/${p.id}/models`, { model_id: 'dup-model', display_name: 'Dup' })
    const createdModel = (await m.json()) as { id: number }
    await json('PUT', `/api/providers/${p.id}/models/${createdModel.id}`, { enabled: false })
    const dup = await json('POST', `/api/providers/${p.id}/models`, { model_id: 'dup-model', display_name: 'Should not apply' })
    expect(dup.status).toBe(409)
    expect(await dup.json()).toEqual({ error: 'model already exists' })
    const list = await (await json('GET', `/api/providers/${p.id}/models`)).json() as Array<{ model_id: string; enabled: boolean }>
    expect(list.find((x) => x.model_id === 'dup-model')?.enabled).toBe(false)
  })

  it('clears extra when protocol changes but leaves it alone otherwise', async () => {
    const created = await json('POST', '/api/providers', { name: 'V', protocol: 'vertex', base_url: 'https://aiplatform.googleapis.com', extra: { project: 'p', location: 'l' } })
    const p = (await created.json()) as { id: number; extra: unknown }
    expect(p.extra).toEqual({ project: 'p', location: 'l' })

    const untouched = await json('PUT', `/api/providers/${p.id}`, { name: 'x' })
    expect((await untouched.json()) as { extra: unknown }).toMatchObject({ extra: { project: 'p', location: 'l' } })

    const switched = await json('PUT', `/api/providers/${p.id}`, { protocol: 'anthropic' })
    expect((await switched.json()) as { extra: unknown; protocol: string }).toMatchObject({ protocol: 'anthropic', extra: null })
  })

  it('round-trips native_files on create and update, defaulting it off', async () => {
    const off = (await (await json('POST', '/api/providers', { name: 'NF-off', protocol: 'openai-completions', base_url: 'https://api.example.com/v1' })).json()) as { id: number; native_files: boolean }
    expect(off.native_files).toBe(false)

    const on = (await (await json('POST', '/api/providers', { name: 'NF-on', protocol: 'openai-responses', base_url: 'https://api.openai.com/v1', native_files: true })).json()) as { id: number; native_files: boolean }
    expect(on.native_files).toBe(true)
    const listed = (await (await json('GET', '/api/providers')).json()) as Array<{ id: number; native_files: boolean }>
    expect(listed.find((x) => x.id === on.id)?.native_files).toBe(true)

    const patched = (await (await json('PUT', `/api/providers/${on.id}`, { native_files: false })).json()) as { native_files: boolean }
    expect(patched.native_files).toBe(false)
    const back = (await (await json('PUT', `/api/providers/${off.id}`, { native_files: true })).json()) as { native_files: boolean }
    expect(back.native_files).toBe(true)
  })

  it('drops provider file pointers when the connection changes but keeps them on an unrelated edit', async () => {
    const db = createDb(env.DB)
    const created = await json('POST', '/api/providers', { name: 'FP', protocol: 'openai-responses', base_url: 'https://api.openai.com/v1', api_key: 'sk-one' })
    const p = (await created.json()) as { id: number }
    const [a] = await db.insert(attachments).values({
      user_id: DEFAULT_USER_ID, sha256: 'f'.repeat(64), mime: 'image/png', size: 4, width: null, height: null,
      r2_key: 'k/fp', origin: 'upload', created_at: 0,
    }).returning()

    const seed = async () => {
      await db.insert(attachmentProviderFiles).values({
        attachment_id: a!.id, provider_id: p.id, provider_reference: { file_id: 'file-1' }, expires_at: 1, created_at: 0,
      }).onConflictDoNothing()
    }
    const pointers = async () => (await db.select().from(attachmentProviderFiles).where(eq(attachmentProviderFiles.provider_id, p.id))).length

    // A rename, or a resend of the same connection fields, must not throw away usable pointers.
    await seed()
    await json('PUT', `/api/providers/${p.id}`, { name: 'FP renamed', protocol: 'openai-responses', base_url: 'https://api.openai.com/v1' })
    expect(await pointers()).toBe(1)

    await json('PUT', `/api/providers/${p.id}`, { base_url: 'https://gateway.example.com/v1' })
    expect(await pointers()).toBe(0)

    await seed()
    await json('PUT', `/api/providers/${p.id}`, { protocol: 'openai-completions' })
    expect(await pointers()).toBe(0)

    await seed()
    await json('PUT', `/api/providers/${p.id}`, { api_key: 'sk-two' })
    expect(await pointers()).toBe(0)
  })
})
