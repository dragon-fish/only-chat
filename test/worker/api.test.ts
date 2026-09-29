import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '@/server/db/client'
import { attachmentProviderFiles, attachments, providers } from '@/server/db/schema'
import { createProject } from '@/server/plugins/hub/projects'
import { ProviderWithInterfacesSchema } from '@/shared/models'
import { catalogApp } from './provider-catalog-fixture'
import { decryptSecret } from '@/server/plugins/llm/crypto'
import { createApp } from '@/server/app'
import { ensureTestUser, authenticatedFetch, authenticatedRequest, workerFetch } from './auth-helper'

let userId: number
beforeEach(async () => {
  const client = await ensureTestUser()
  const session = await (await client.request('/api/auth/get-session')).json() as { user: { id: string } }
  userId = Number(session.user.id)
})

const json = (method: string, path: string, body?: unknown) =>
  authenticatedFetch(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }))

describe('provider file cleanup before configuration changes', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it.each(['key', 'clear-key', 'endpoint', 'interface', 'provider'] as const)('attempts old-scope deletes before a %s change and commits despite remote auth failure', async change => {
    const { ctx, request, createProvider } = await catalogApp()
    const inputs = [
      { protocol: 'responses' as const, base_url: 'https://gateway.test/v1', native_files: true },
      { protocol: 'anthropic' as const, base_url: 'https://gateway.test/messages', native_files: true },
    ]
    const provider = await createProvider({ api_key: 'original-key', interfaces: inputs })
    const [attachment] = await ctx.db.orm.insert(attachments).values({ user_id: userId, sha256: crypto.randomUUID(), mime: 'text/plain', size: 1, r2_key: crypto.randomUUID(), origin: 'upload', created_at: 0 }).returning()
    for (const [family, base_url] of [['openai', 'https://gateway.test/v1'], ['anthropic', 'https://gateway.test/messages']] as const) {
      await ctx.db.orm.insert(attachmentProviderFiles).values({
        attachment_id: attachment!.id, provider_id: provider.id, credential_version: 1, file_family: family, base_url,
        provider_reference: { [family]: 'file-live' }, expires_at: Date.now() + 86_400_000, cleanup_after: Date.now() + 86_400_000, created_at: 0,
      })
    }
    const visited: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const remote = new Request(input, init)
      expect(remote.method).toBe('DELETE')
      expect(remote.headers.get('authorization') ?? remote.headers.get('x-api-key')).toMatch(/original-key/)
      const stored = await ctx.db.orm.query.providers.findFirst({ where: eq(providers.id, provider.id) })
      expect(await decryptSecret(env.KEY_ENCRYPTION_SECRET, stored!.api_key!)).toBe('original-key')
      expect(await env.DB.prepare('SELECT base_url FROM provider_interfaces WHERE id = ?').bind(provider.interfaces[0]!.id).first('base_url')).toBe('https://gateway.test/v1')
      visited.push(remote.url)
      return Response.json({ error: { message: 'Bearer original-key private-body', type: 'error' } }, { status: 401 })
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const response = change === 'provider'
      ? await request('DELETE', `/providers/${provider.id}`)
      : await request('PUT', `/providers/${provider.id}`, {
        name: 'Changed', default_protocol: change === 'interface' ? 'anthropic' : 'responses',
        interfaces: change === 'interface' ? inputs.slice(1) : change === 'endpoint' ? [{ ...inputs[0], base_url: 'https://new.test/v1' }, inputs[1]] : inputs,
        ...(change === 'key' ? { api_key: 'new-key' } : change === 'clear-key' ? { api_key: '' } : {}),
      })
    expect(response.status).toBe(change === 'provider' ? 204 : 200)
    expect(visited).toHaveLength(['endpoint', 'interface'].includes(change) ? 1 : 2)
    const remaining = await ctx.db.orm.select().from(attachmentProviderFiles).where(eq(attachmentProviderFiles.provider_id, provider.id))
    expect(remaining.map(row => row.file_family)).toEqual(['endpoint', 'interface'].includes(change) ? ['anthropic'] : [])
    const stored = await ctx.db.orm.query.providers.findFirst({ where: eq(providers.id, provider.id) })
    if (change === 'key') {
      expect(stored!.credential_version).toBe(2)
      expect(await decryptSecret(env.KEY_ENCRYPTION_SECRET, stored!.api_key!)).toBe('new-key')
    } else if (change === 'clear-key') expect(stored!.api_key).toBeNull()
    else if (change === 'provider') expect(stored).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/original-key|private-body/)
  })

  it('retains the shared OpenAI scope when one interface is removed and the key stays unchanged', async () => {
    const { ctx, request, createProvider } = await catalogApp()
    const provider = await createProvider({ api_key: 'original-key', interfaces: [
      { protocol: 'responses', base_url: 'https://gateway.test/v1/', native_files: true },
      { protocol: 'chat-completions', base_url: 'https://gateway.test/v1', native_files: true },
    ] })
    const [attachment] = await ctx.db.orm.insert(attachments).values({ user_id: userId, sha256: crypto.randomUUID(), mime: 'text/plain', size: 1, r2_key: crypto.randomUUID(), origin: 'upload', created_at: 0 }).returning()
    await ctx.db.orm.insert(attachmentProviderFiles).values({ attachment_id: attachment!.id, provider_id: provider.id, credential_version: 1, file_family: 'openai', base_url: 'https://gateway.test/v1', provider_reference: { openai: 'file-shared' }, expires_at: Date.now() + 86_400_000, cleanup_after: Date.now() + 86_400_000, created_at: 0 })
    const remote = vi.fn()
    vi.stubGlobal('fetch', remote)
    expect((await request('PUT', `/providers/${provider.id}`, { name: 'Shared', api_key: 'original-key', default_protocol: 'chat-completions', interfaces: [{ protocol: 'chat-completions', base_url: 'https://gateway.test/v1', native_files: true }] })).status).toBe(200)
    expect(remote).not.toHaveBeenCalled()
    expect(await ctx.db.orm.select().from(attachmentProviderFiles).where(eq(attachmentProviderFiles.provider_id, provider.id))).toHaveLength(1)
  })

  it('retains legacy URL aliases across an equivalent endpoint edit beyond one normalization page', async () => {
    const { ctx, request, createProvider } = await catalogApp()
    const provider = await createProvider({ api_key: 'original-key', interfaces: [
      { protocol: 'responses', base_url: 'https://GATEWAY.test:443/api/./v1///', native_files: true },
    ] })
    const [attachment] = await ctx.db.orm.insert(attachments).values({ user_id: userId, sha256: crypto.randomUUID(), mime: 'text/plain', size: 1, r2_key: crypto.randomUUID(), origin: 'upload', created_at: 0 }).returning()
    await env.DB.prepare(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM ids WHERE n < 53)
      INSERT INTO attachment_provider_files (attachment_id, provider_id, credential_version, file_family, base_url, provider_reference, expires_at, cleanup_after, created_at)
      SELECT ?, ?, 1, 'openai', 'https://GATEWAY.test:443/api/./v1', json_object('openai', 'legacy-' || n), 1000, 1000, n FROM ids`)
      .bind(attachment!.id, provider.id).run()
    const remote = vi.fn()
    vi.stubGlobal('fetch', remote)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await request('PUT', `/providers/${provider.id}`, {
      name: 'Same endpoint', default_protocol: 'responses', interfaces: [{ protocol: 'responses', base_url: 'https://gateway.test/api/v1', native_files: true }],
    })).status).toBe(200)
    expect.soft(remote).not.toHaveBeenCalled()
    const rows = await ctx.db.orm.select().from(attachmentProviderFiles).where(eq(attachmentProviderFiles.provider_id, provider.id))
    expect(rows).toHaveLength(53)
    expect(rows.every(row => row.base_url === 'https://gateway.test/api/v1')).toBe(true)
  })
})

describe('atomic provider interface API', () => {
  it.each(['stale-key', '', undefined])('retains the original credential guard across source retries (api_key=%s)', async api_key => {
    const { request, createProvider } = await catalogApp()
    const provider = await createProvider({ api_key: 'original-key' })
    let arrive!: () => void
    let release!: () => void
    const arrived = new Promise<void>(resolve => { arrive = resolve })
    const resume = new Promise<void>(resolve => { release = resolve })
    const delayedDB = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'batch') return async (statements: D1PreparedStatement[]) => { arrive(); await resume; return target.batch(statements) }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const delayed = await createApp({ env: { ...env, DB: delayedDB }, side: 'worker' })
    const pending = authenticatedRequest(delayed.api, `/api/providers/${provider.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      name: 'Stale request', enabled: true, api_key, default_protocol: 'responses', models_dev_provider: { source: 'endpoint' },
      interfaces: [{ protocol: 'responses', base_url: 'https://gateway.test/v1' }],
    }) })
    await arrived
    let newer
    try {
      const saved = await request('PUT', `/providers/${provider.id}`, {
        name: 'Newer config', enabled: false, api_key: 'current-key', default_protocol: 'anthropic', models_dev_provider: { source: 'endpoint' },
        interfaces: [{ protocol: 'responses', base_url: 'https://gateway.test/v1' }, { protocol: 'anthropic', base_url: 'https://lab.test/v1' }],
      })
      expect(saved.status).toBe(200)
      newer = ProviderWithInterfacesSchema.parse(await saved.json())
    } finally { release() }
    expect((await pending).status).toBe(api_key === undefined ? 200 : 409)
    const row = await env.DB.prepare('SELECT api_key, credential_version FROM providers WHERE id = ?').bind(provider.id).first<{ api_key: string; credential_version: number }>()
    expect(row?.credential_version).toBe(2)
    expect(await decryptSecret(env.KEY_ENCRYPTION_SECRET, row!.api_key)).toBe('current-key')
    const listed = await (await request('GET', '/providers')).json() as unknown[]
    const current = listed.map(value => ProviderWithInterfacesSchema.parse(value)).find(value => value.id === provider.id)!
    if (api_key === undefined) expect(current.name).toBe('Stale request')
    else expect(current).toEqual(newer)
  })

  it.each([false, true])('protects credentials when an older provider write resumes (writesKey=%s)', async writesKey => {
    const { request, createProvider } = await catalogApp()
    const provider = await createProvider({ api_key: 'original-key' })
    let release!: () => void
    let arrive!: () => void
    const resume = new Promise<void>(resolve => { release = resolve })
    const arrived = new Promise<void>(resolve => { arrive = resolve })
    const delayedDB = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'batch') return async (statements: D1PreparedStatement[]) => { arrive(); await resume; return target.batch(statements) }
        const member = Reflect.get(target, property)
        return typeof member === 'function' ? member.bind(target) : member
      },
    })
    const delayed = await createApp({ env: { ...env, DB: delayedDB }, side: 'worker' })
    const input = { name: 'Concurrent rename', default_protocol: 'responses', interfaces: [{ protocol: 'responses', base_url: 'https://gateway.test/v1' }] }
    const pending = authenticatedRequest(delayed.api, `/api/providers/${provider.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, ...(writesKey ? { api_key: 'stale-key' } : {}) }) })
    await arrived
    try {
      expect((await request('PUT', `/providers/${provider.id}`, { ...input, api_key: 'current-key' })).status).toBe(200)
    } finally { release() }
    const stale = await pending
    expect(stale.status).toBe(writesKey ? 409 : 200)
    const row = await env.DB.prepare('SELECT api_key, credential_version FROM providers WHERE id = ?').bind(provider.id).first<{ api_key: string; credential_version: number }>()
    expect(row?.credential_version).toBe(2)
    expect(await decryptSecret(env.KEY_ENCRYPTION_SECRET, row!.api_key)).toBe('current-key')
  })

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
  it('returns the application user DTO with a millisecond creation timestamp', async () => {
    const res = await json('GET', '/api/me')
    expect(res.status).toBe(200)
    const stored = await env.DB.prepare('SELECT created_at FROM users WHERE id = ?').bind(userId).first<{ created_at: number }>()
    expect(await res.json()).toEqual({
      id: userId, name: 'owner', email: 'owner@example.com', role: 'user', settings: { plugins: {} },
      plugin_config: {
        tavily: { configured: false, values: {}, secrets: { api_key: false } },
        // Every field has a default, so these plugins are configured before anyone touches them.
        workspace_files: { configured: true, values: {}, secrets: {} },
        cloudflare_browser_run: { configured: true, values: {}, secrets: {} },
        comfyui: { configured: false, values: {}, secrets: {} },
      },
      created_at: stored!.created_at,
    })
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
    const list = await (await json('GET', `/api/providers/${p.id}/models/summary`)).json() as { models: Array<{ model_id: string }> }
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
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
    const check1 = await (await json('POST', '/api/attachments/check', { sha256: sha })).json() as { exists: boolean }
    expect(check1.exists).toBe(false)
    const up = await authenticatedFetch(new Request(`https://x/api/attachments/${sha}?w=2&h=2`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: bytes }))
    expect(up.status).toBe(201)
    const { attachment_id } = (await up.json()) as { attachment_id: number }
    const check2 = await (await json('POST', '/api/attachments/check', { sha256: sha })).json() as { exists: boolean; attachment_id: number }
    expect(check2).toEqual({ exists: true, attachment_id })
    const got = await authenticatedFetch(new Request(`https://x/api/attachments/${attachment_id}`))
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes)
  })

  it('lets a browser keep an attachment, and never a shared cache', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9])
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
    const up = await authenticatedFetch(new Request(`https://x/api/attachments/${sha}`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: bytes }))
    const { attachment_id } = (await up.json()) as { attachment_id: number }

    const got = await authenticatedFetch(new Request(`https://x/api/attachments/${attachment_id}`))
    // The bytes under an id never change, so revalidating costs a round trip and settles nothing.
    // `private` is the load-bearing word: the URL names no user, and a shared cache in front of
    // this Worker would answer one account's request with another account's picture.
    expect(got.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(got.headers.get('etag')).toBe(`"${sha}"`)
    expect(got.headers.get('vary')).toBe('Cookie')

    const revalidated = await authenticatedFetch(new Request(`https://x/api/attachments/${attachment_id}`, { headers: { 'if-none-match': `"${sha}"` } }))
    expect(revalidated.status).toBe(304)
    expect(await revalidated.text()).toBe('')
    const changed = await authenticatedFetch(new Request(`https://x/api/attachments/${attachment_id}`, { headers: { 'if-none-match': '"other"' } }))
    expect(changed.status).toBe(200)
  })

  it('never lets a refusal be cached, now that a success can be', async () => {
    // A 404 is cacheable by default where a 401 is not, so the refusal a browser is most likely to
    // store is the one that says an id is not yours. Stored, it outlives the reason it was given.
    const missing = await authenticatedFetch(new Request('https://x/api/attachments/99999999'))
    expect(missing.status).toBe(404)
    expect(missing.headers.get('cache-control')).toBe('no-store')

    const unauthenticated = await workerFetch('/api/attachments/1')
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.headers.get('cache-control')).toBe('no-store')
  })

  it('serves a generated attachment through the same authenticated route', async () => {
    // Assistant images reuse the upload route's reader; no public or unauthenticated path exists.
    const db = createDb(env.DB)
    const bytes = new Uint8Array([137, 80, 78, 71, 71, 69, 78])
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
    const key = `${userId}/${sha.slice(0, 2)}/${sha}`
    await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: 'image/png' } })
    const [row] = await db.insert(attachments).values({
      user_id: userId, sha256: sha, mime: 'image/png', size: bytes.byteLength,
      width: null, height: null, r2_key: key, origin: 'generated', created_at: 0,
    }).onConflictDoUpdate({ target: [attachments.user_id, attachments.sha256], set: { r2_key: key } }).returning()

    const got = await authenticatedFetch(new Request(`https://x/api/attachments/${row!.id}`))
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes)
  })

  it('rejects an upload whose hash does not match', async () => {
    const res = await authenticatedFetch(new Request(`https://x/api/attachments/${'0'.repeat(64)}`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9]) }))
    expect(res.status).toBe(400)
  })

  it('lists conversations and messages', async () => {
    const res = await json('GET', '/api/conversations')
    expect(res.status).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
    expect((await json('GET', '/api/conversations/999999/messages')).status).toBe(404)
  })

  it('lists projects for the current user, read-only', async () => {
    const db = createDb(env.DB)
    const mine = await createProject(db, { user_id: userId, name: 'Mine', system_prompt: 'sys' })
    const list = await (await json('GET', '/api/projects')).json() as Array<{ id: number; name: string }>
    expect(list.find((p) => p.id === mine.id)).toMatchObject({ name: 'Mine', system_prompt: 'sys' })
    expect((await json('POST', '/api/projects', { name: 'nope' })).status).toBe(404)
  })

  it('pins a duplicate model_id without replacing the existing edit', async () => {
    const created = await json('POST', '/api/providers', { name: 'C', interfaces: [{ protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1' }], default_protocol: 'anthropic' })
    const p = (await created.json()) as { id: number }
    const m = await json('POST', `/api/providers/${p.id}/models`, { model_id: 'dup-model', metadata_override: { name: 'Dup' } })
    const createdModel = (await m.json()) as { id: number }
    await json('PUT', `/api/providers/${p.id}/models/${createdModel.id}`, { enabled: false })
    const dup = await json('POST', `/api/providers/${p.id}/models`, { model_id: 'dup-model', metadata_override: { name: 'Should not apply' } })
    expect(dup.status).toBe(200)
    expect(await dup.json()).toMatchObject({ model_id: 'dup-model', enabled: false, manual_pinned: true, metadata_override: { name: 'Dup' } })
    const list = await (await json('GET', `/api/providers/${p.id}/models/summary`)).json() as { models: Array<{ model_id: string; enabled: boolean; manual_pinned: boolean }> }
    expect(list.models.find((x) => x.model_id === 'dup-model')).toMatchObject({ enabled: false, manual_pinned: true })
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

  it('retains file references on rename and invalidates them when credentials change', async () => {
    const db = createDb(env.DB)
    const input = { name: 'FP', interfaces: [{ protocol: 'responses', base_url: 'https://api.openai.com/v1' }], default_protocol: 'responses' }
    const created = await json('POST', '/api/providers', { ...input, api_key: 'sk-one' })
    const p = (await created.json()) as { id: number }
    const [a] = await db.insert(attachments).values({
      user_id: userId, sha256: 'f'.repeat(64), mime: 'image/png', size: 4, width: null, height: null,
      r2_key: 'k/fp', origin: 'upload', created_at: 0,
    }).returning()

    const seed = async () => {
      await db.insert(attachmentProviderFiles).values({
        attachment_id: a!.id, provider_id: p.id, file_family: 'openai', base_url: 'https://api.openai.com/v1',
        provider_reference: { file_id: 'unusable-reference' }, expires_at: 1, created_at: 0,
      }).onConflictDoNothing()
    }
    const pointers = async () => (await db.select().from(attachmentProviderFiles).where(eq(attachmentProviderFiles.provider_id, p.id))).length

    await seed()
    await json('PUT', `/api/providers/${p.id}`, { ...input, name: 'FP renamed' })
    expect(await pointers()).toBe(1)
    const changed = ProviderWithInterfacesSchema.parse(await (await json('PUT', `/api/providers/${p.id}`, { ...input, api_key: 'sk-two' })).json())
    expect(changed.credential_version).toBe(2)
    expect(await pointers()).toBe(0)
  })
})
