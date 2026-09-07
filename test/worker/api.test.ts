import { env, exports } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { attachmentProviderFiles, attachments } from '@/server/db/schema'
import { createProject } from '@/server/plugins/hub/projects'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { ProviderWithInterfacesSchema } from '@/shared/models'
import { catalogApp } from './provider-catalog-fixture'
import { decryptSecret } from '@/server/plugins/llm/crypto'

const json = (method: string, path: string, body?: unknown) =>
  exports.default.fetch(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }))

describe('atomic provider interface API', () => {
  it('uses the default endpoint first, then same-origin siblings, and reports conflicts without blocking save', async () => {
    const { request, createProvider } = await catalogApp()
    const sibling = await createProvider({ interfaces: [
      { protocol: 'responses', base_url: 'https://gateway.test/responses' },
      { protocol: 'chat-completions', base_url: 'https://gateway.test/v1' },
      { protocol: 'anthropic', base_url: 'https://lab.test/v1' },
    ] })
    expect(sibling.models_dev_provider_id).toBe('gateway')
    const conflict = await request('PUT', `/providers/${sibling.id}`, {
      name: 'Conflict', default_protocol: 'responses', interfaces: [
        { protocol: 'responses', base_url: 'https://gateway.test/responses' },
        { protocol: 'chat-completions', base_url: 'https://gateway.test/v1' },
        { protocol: 'anthropic', base_url: 'https://gateway.test/messages' },
      ],
    })
    expect(conflict.status).toBe(200)
    expect(conflict.headers.get('X-Provider-Association-Warning')).toContain('different catalog providers')
    expect(await conflict.json()).toMatchObject({ name: 'Conflict', models_dev_provider_id: null, models_dev_provider_source: 'endpoint' })
    const defaultWins = await createProvider({ interfaces: [
      { protocol: 'responses', base_url: 'https://gateway.test/v1' },
      { protocol: 'anthropic', base_url: 'https://gateway.test/messages' },
    ] })
    expect(defaultWins.models_dev_provider_id).toBe('gateway')
  })

  it('rolls back the provider and interface changes when an interface write fails', async () => {
    const { request, createProvider } = await catalogApp()
    const provider = await createProvider()
    await env.DB.exec("CREATE TRIGGER test_interface_failure BEFORE UPDATE ON provider_interfaces WHEN new.base_url = 'https://reject.test/v1' BEGIN SELECT RAISE(ABORT, 'injected interface failure'); END")
    try {
      const response = await request('PUT', `/providers/${provider.id}`, { name: 'Must roll back', default_protocol: 'responses', interfaces: [{ protocol: 'responses', base_url: 'https://reject.test/v1' }] })
      expect(response.status).toBe(500)
      expect(await env.DB.prepare('SELECT name, default_interface_id FROM providers WHERE id = ?').bind(provider.id).first()).toEqual({ name: 'Gateway', default_interface_id: provider.default_interface_id })
      expect(await env.DB.prepare('SELECT base_url FROM provider_interfaces WHERE id = ?').bind(provider.default_interface_id).first()).toEqual({ base_url: 'https://gateway.test/v1' })
    } finally { await env.DB.exec('DROP TRIGGER test_interface_failure') }
  })

  it('stores one encrypted credential and an owned default interface, without leaking legacy fields', async () => {
    const { createProvider } = await catalogApp()
    const provider = ProviderWithInterfacesSchema.parse(await createProvider({ api_key: 'shared-secret', interfaces: [
      { protocol: 'responses', base_url: 'https://gateway.test/v1', native_files: true },
      { protocol: 'anthropic', base_url: 'https://gateway.test/anthropic' },
    ] }))
    expect(provider.interfaces).toHaveLength(2)
    expect(provider.default_interface_id).toBe(provider.interfaces.find(item => item.protocol === 'responses')?.id)
    expect(provider).toMatchObject({ has_key: true, credential_version: 1, models_dev_provider_id: 'gateway', models_dev_provider_source: 'endpoint' })
    const row = await env.DB.prepare('SELECT api_key FROM providers WHERE id = ?').bind(provider.id).first<{ api_key: string }>()
    expect(row?.api_key).not.toContain('shared-secret')
    expect(await decryptSecret(env.KEY_ENCRYPTION_SECRET, row!.api_key)).toBe('shared-secret')
  })

  it('rematches endpoint associations while preserving manual choices and increments credentials only on changes', async () => {
    const { request, createProvider } = await catalogApp()
    const provider = await createProvider({ api_key: 'one' })
    const write = (patch: Record<string, unknown> = {}) => request('PUT', `/providers/${provider.id}`, {
      name: provider.name, interfaces: provider.interfaces.map(({ id, protocol, base_url, native_files }) => ({ id, protocol, base_url, native_files })),
      default_protocol: 'responses', ...patch,
    })
    expect((await (await write({ api_key: 'one' })).json() as { credential_version: number }).credential_version).toBe(1)
    expect((await (await write({ api_key: 'two' })).json() as { credential_version: number }).credential_version).toBe(2)
    expect((await (await write({ api_key: '' })).json() as { credential_version: number }).credential_version).toBe(3)
    expect((await (await write({ api_key: '' })).json() as { credential_version: number }).credential_version).toBe(3)
    const changed = await write({ interfaces: [{ ...provider.interfaces[0], provider_id: undefined, created_at: undefined, base_url: 'https://lab.test/v1' }] })
    expect(await changed.json()).toMatchObject({ models_dev_provider_id: 'lab', models_dev_provider_source: 'endpoint' })
    expect(await (await write({ models_dev_provider: { source: 'manual', provider_id: 'lab' } })).json()).toMatchObject({ models_dev_provider_id: 'lab', models_dev_provider_source: 'manual' })
    expect(await (await write()).json()).toMatchObject({ models_dev_provider_id: 'lab', models_dev_provider_source: 'manual' })
  })

  it('rejects invalid defaults, duplicate protocols, foreign IDs and Vertex Files before changing a provider', async () => {
    const { request, createProvider } = await catalogApp()
    const first = await createProvider()
    const other = await createProvider()
    const interfaceInput = { protocol: 'responses', base_url: 'https://gateway.test/v1' }
    for (const patch of [
      { default_protocol: 'anthropic' },
      { interfaces: [interfaceInput, interfaceInput] },
      { interfaces: [{ ...interfaceInput, id: other.interfaces[0]!.id }] },
      { interfaces: [{ protocol: 'vertex-compatible', base_url: 'https://gateway.test/v1', native_files: true }], default_protocol: 'vertex-compatible' },
    ]) {
      expect((await request('PUT', `/providers/${first.id}`, { name: 'Must not save', interfaces: [interfaceInput], default_protocol: 'responses', ...patch })).status).toBe(400)
    }
    expect(await env.DB.prepare('SELECT name FROM providers WHERE id = ?').bind(first.id).first()).toEqual({ name: 'Gateway' })
    expect((await env.DB.prepare('SELECT id FROM provider_interfaces WHERE provider_id = ?').bind(first.id).all()).results).toHaveLength(1)
  })
})

describe('REST api', () => {
  it('returns the default user', async () => {
    const res = await json('GET', '/api/me')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 1, settings: { plugins: {} } })
  })

  it('creates a provider without leaking the key, lists models, deletes', async () => {
    const input = { name: 'A', interfaces: [{ protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1' }], default_protocol: 'anthropic', api_key: 'sk-secret' }
    const created = await json('POST', '/api/providers', input)
    expect(created.status).toBe(201)
    const p = (await created.json()) as { id: number; has_key: boolean; api_key?: string }
    expect(p.has_key).toBe(true)
    expect(p.api_key).toBeUndefined()

    const m = await json('POST', `/api/providers/${p.id}/models`, { model_id: 'claude-x', metadata_override: { name: 'Claude X', modalities: { input: ['text', 'image'] } } })
    expect(m.status).toBe(201)
    const list = await (await json('GET', `/api/providers/${p.id}/models`)).json() as { models: Array<{ model_id: string }> }
    expect(list.models.map((x) => x.model_id)).toEqual(['claude-x'])

    const upd = await json('PUT', `/api/providers/${p.id}`, { ...input, name: 'B', api_key: undefined })
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
    const created = await json('POST', '/api/providers', { name: 'C', interfaces: [{ protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1' }], default_protocol: 'anthropic' })
    const p = (await created.json()) as { id: number }
    const m = await json('POST', `/api/providers/${p.id}/models`, { model_id: 'dup-model', metadata_override: { name: 'Dup' } })
    const createdModel = (await m.json()) as { id: number }
    await json('PUT', `/api/providers/${p.id}/models/${createdModel.id}`, { enabled: false })
    const dup = await json('POST', `/api/providers/${p.id}/models`, { model_id: 'dup-model', metadata_override: { name: 'Should not apply' } })
    expect(dup.status).toBe(409)
    expect(await dup.json()).toEqual({ error: 'model already exists' })
    const list = await (await json('GET', `/api/providers/${p.id}/models`)).json() as { models: Array<{ model_id: string; enabled: boolean }> }
    expect(list.models.find((x) => x.model_id === 'dup-model')?.enabled).toBe(false)
  })

  it('rejects native Vertex and the retired single-protocol input', async () => {
    expect((await json('POST', '/api/providers', { name: 'V', protocol: 'vertex', base_url: 'https://aiplatform.googleapis.com', extra: { project: 'p', location: 'l' } })).status).toBe(400)
    expect((await json('POST', '/api/providers', { name: 'V', interfaces: [{ protocol: 'vertex', base_url: 'https://aiplatform.googleapis.com' }], default_protocol: 'vertex' })).status).toBe(400)
  })

  it('round-trips native_files on create and update, defaulting it off', async () => {
    const input = { name: 'NF', interfaces: [{ protocol: 'responses', base_url: 'https://api.example.com/v1' }], default_protocol: 'responses' }
    const off = ProviderWithInterfacesSchema.parse(await (await json('POST', '/api/providers', input)).json())
    expect(off.interfaces[0]?.native_files).toBe(false)
    const on = ProviderWithInterfacesSchema.parse(await (await json('PUT', `/api/providers/${off.id}`, { ...input, interfaces: [{ ...input.interfaces[0], native_files: true }] })).json())
    expect(on.interfaces[0]?.native_files).toBe(true)
    const back = ProviderWithInterfacesSchema.parse(await (await json('PUT', `/api/providers/${off.id}`, input)).json())
    expect(back.interfaces[0]?.native_files).toBe(false)
  })

  it('retains historical file references for cleanup and versions new credentials', async () => {
    const db = createDb(env.DB)
    const input = { name: 'FP', interfaces: [{ protocol: 'responses', base_url: 'https://api.openai.com/v1' }], default_protocol: 'responses' }
    const created = await json('POST', '/api/providers', { ...input, api_key: 'sk-one' })
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

    await seed()
    await json('PUT', `/api/providers/${p.id}`, { ...input, name: 'FP renamed' })
    expect(await pointers()).toBe(1)
    const changed = ProviderWithInterfacesSchema.parse(await (await json('PUT', `/api/providers/${p.id}`, { ...input, api_key: 'sk-two' })).json())
    expect(changed.credential_version).toBe(2)
    expect(await pointers()).toBe(1)
  })
})
