import { runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserHub } from '@/server/index'
import { createDb } from '@/server/db/client'
import { providers } from '@/server/db/schema'
import { CodexCredentialStore } from '@/server/plugins/codex/credentials'
import { decryptJson, encryptJson } from '@/server/plugins/llm/crypto'
import { CodexOAuthPollResponseSchema, CodexOAuthStartResponseSchema } from '@/shared/api'
import { createCodexModel } from '@/server/plugins/llm/providers/codex'
import { createApp } from '@/server/app'

const request = (method: string, path: string) => exports.default.fetch(new Request(`https://x/api${path}`, { method }))
const stub = () => env.USER_HUB.getByName('1')
const db = createDb(env.DB)
const store = new CodexCredentialStore(db, env.KEY_ENCRYPTION_SECRET)
const jwt = (accountId: string) => `header.${btoa(JSON.stringify({ email: 'owner@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }))}.signature`
let accountId: string
let authorized: boolean
let modelFailure: boolean
let calls: string[]
let pollWait: (() => Promise<void>) | undefined

beforeEach(async () => {
  await db.delete(providers)
  accountId = 'private-account'
  authorized = true
  modelFailure = false
  calls = []
  pollWait = undefined
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    calls.push(req.url)
    if (req.url.endsWith('/deviceauth/usercode')) return Response.json({ device_auth_id: 'private-device', user_code: 'PRIVATE-CODE', interval: 5 })
    if (req.url.endsWith('/deviceauth/token')) {
      await pollWait?.()
      return authorized
        ? Response.json({ authorization_code: 'private-code', code_verifier: 'private-verifier', code_challenge: 'challenge' })
        : Response.json({}, { status: 403 })
    }
    if (req.url.endsWith('/oauth/token')) return Response.json({ id_token: jwt(accountId), access_token: 'private-access', refresh_token: 'private-refresh', token_type: 'Bearer', expires_in: 3600 })
    if (req.url.endsWith('/models')) return modelFailure
      ? Response.json({ error: 'private-upstream-body' }, { status: 500 })
      : Response.json({ models: [{ slug: 'codex-test' }] })
    throw new Error(`Unexpected URL ${req.url}`)
  })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function start(path = '/codex/oauth/start') {
  const response = await request('POST', path)
  expect(response.status).toBe(201)
  return CodexOAuthStartResponseSchema.parse(await response.json())
}
async function poll(id: string) {
  const response = await request('POST', `/codex/oauth/${id}/poll`)
  expect(response.status).toBe(200)
  return CodexOAuthPollResponseSchema.parse(await response.json())
}

describe('Codex OAuth REST boundary', () => {
  it.each(['disconnect', 'delete'] as const)('still performs local %s when revoke fails and sends only the refresh token', async operation => {
    const result = await poll((await start()).flow_id)
    if (result.status !== 'complete') throw new Error('Missing provider')
    const id = result.provider.id
    const beforeModels = await db.query.models.findMany()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const revoked: unknown[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      expect(req.url).toBe('https://auth.openai.com/oauth/revoke')
      expect(req.method).toBe('POST')
      revoked.push(await req.json())
      expect(await store.read(id)).toMatchObject({ status: 'connected' })
      return Response.json({ error: 'private-revoke-body', access_token: 'private-access' }, { status: 500 })
    })
    const response = await request(operation === 'delete' ? 'DELETE' : 'POST', operation === 'delete' ? `/providers/${id}` : `/providers/${id}/codex/disconnect`)
    expect(response.status).toBe(204)
    expect(revoked).toEqual([{ token: 'private-refresh', token_type_hint: 'refresh_token', client_id: expect.any(String) }])
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-|owner@example|account/)
    expect(warn).toHaveBeenCalled()
    if (operation === 'delete') {
      expect(await store.read(id)).toBeNull()
      expect(await db.query.providerInterfaces.findMany()).toEqual([])
      expect(await db.query.models.findMany()).toEqual([])
    } else {
      expect(await store.read(id)).toMatchObject({ status: 'disconnected', bundle: null, revision: 2, credentialVersion: 2 })
      expect(await db.query.models.findMany()).toEqual(beforeModels)
      expect((await request('POST', `/providers/${id}/codex/disconnect`)).status).toBe(204)
      expect(revoked).toHaveLength(1)
      expect(await store.read(id)).toMatchObject({ revision: 2, credentialVersion: 2 })
    }
  })

  it('rejects generation from a model created before local disconnect without upstream I/O', async () => {
    const result = await poll((await start()).flow_id)
    if (result.status !== 'complete') throw new Error('Missing provider')
    await runInDurableObject(stub(), async (instance: UserHub) => {
      const provider = (await db.query.providers.findFirst())!
      const endpoint = (await db.query.providerInterfaces.findFirst())!
      const model = (await db.query.models.findFirst())!
      const languageModel = await createCodexModel(instance.app.codex, provider, endpoint, model)
      if (typeof languageModel === 'string') throw new Error('Expected a resolved model')
      vi.stubGlobal('fetch', async () => new Response(null, { status: 200 }))
      expect((await request('POST', `/providers/${provider.id}/codex/disconnect`)).status).toBe(204)
      const upstream = vi.fn(async () => { throw new Error('Upstream must not be called') })
      vi.stubGlobal('fetch', upstream)
      await expect(languageModel.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })).rejects.toThrow(/Codex/)
      expect(upstream).not.toHaveBeenCalled()
    })
  })

  it.each([
    { operation: 'disconnect', change: 'reconnect' }, { operation: 'delete', change: 'reconnect' },
    { operation: 'disconnect', change: 'refresh' }, { operation: 'delete', change: 'refresh' },
  ])('preserves a concurrent $change when a stale $operation finishes revoking', async ({ operation, change }) => {
    const result = await poll((await start()).flow_id)
    if (result.status !== 'complete') throw new Error('Missing provider')
    const id = result.provider.id
    const original = (await store.read(id))!
    vi.stubGlobal('fetch', async () => {
      const rotated = { ...original.bundle!, refreshToken: 'new-refresh' }
      if (change === 'reconnect') await store.reconnect(id, original.revision, rotated, Date.now())
      else await store.storeRefresh(original, rotated, Date.now())
      return new Response(null, { status: 200 })
    })
    const response = await request(operation === 'delete' ? 'DELETE' : 'POST', operation === 'delete' ? `/providers/${id}` : `/providers/${id}/codex/disconnect`)
    expect(response.status).toBe(409)
    expect(await store.read(id)).toMatchObject({ status: 'connected', bundle: { refreshToken: 'new-refresh' }, revision: 2, credentialVersion: change === 'reconnect' ? 2 : 1 })
  })

  it('does not delete a reconnect committed after prepare-delete cleared the old connection', async () => {
    const result = await poll((await start()).flow_id)
    if (result.status !== 'complete') throw new Error('Missing provider')
    const id = result.provider.id
    const original = (await store.read(id))!
    vi.stubGlobal('fetch', async () => new Response(null, { status: 200 }))
    const hub = stub()
    const app = await createApp({ side: 'worker', env: { ...env, USER_HUB: new Proxy(env.USER_HUB, {
      get(target, property) {
        if (property === 'getByName') return () => new Proxy(hub, {
          get(stubTarget, key) {
            if (key === 'prepareCodexDelete') return async (providerId: number) => {
              const prepared = await stubTarget.prepareCodexDelete(providerId)
              if (prepared.status !== 'disconnected') throw new Error('Expected local clear')
              await store.reconnect(id, prepared.revision, { ...original.bundle!, refreshToken: 'new-refresh' }, Date.now())
              return prepared
            }
            return Reflect.get(stubTarget, key)
          },
        })
        return Reflect.get(target, property)
      },
    }) } })
    const response = await app.api.fetch(new Request(`https://x/api/providers/${id}`, { method: 'DELETE' }), app.env)
    expect(response.status).toBe(409)
    expect(await store.read(id)).toMatchObject({ status: 'connected', bundle: { refreshToken: 'new-refresh' }, revision: 3, credentialVersion: 3 })
  })

  it.each(['disconnect', 'delete'] as const)('clears unreadable local credentials during %s without exposing ciphertext', async operation => {
    const result = await poll((await start()).flow_id)
    if (result.status !== 'complete') throw new Error('Missing provider')
    const id = result.provider.id
    await env.DB.prepare('UPDATE provider_oauth_credentials SET encrypted_bundle = ? WHERE provider_id = ?').bind('private-invalid-ciphertext', id).run()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const response = await request(operation === 'delete' ? 'DELETE' : 'POST', operation === 'delete' ? `/providers/${id}` : `/providers/${id}/codex/disconnect`)
    expect(response.status).toBe(204)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-invalid-ciphertext')
    expect(await store.read(id)).toEqual(operation === 'delete' ? null : expect.objectContaining({ status: 'disconnected', bundle: null }))
  })

  it('rejects invalid, missing, and custom disconnect targets before upstream I/O', async () => {
    const [custom] = await db.insert(providers).values({ user_id: 1, name: 'Custom', created_at: 0 }).returning()
    for (const id of ['no', '999999', custom!.id]) expect((await request('POST', `/providers/${id}/codex/disconnect`)).status).toBe(404)
    expect(calls).toEqual([])
  })

  it.each(['disconnect', 'delete'] as const)('aborts stalled revoke before completing local %s', async operation => {
    const result = await poll((await start()).flow_id)
    if (result.status !== 'complete') throw new Error('Missing provider')
    const id = result.provider.id
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let entered!: (signal: AbortSignal) => void
    let rejectPending!: (error: Error) => void
    const started = new Promise<AbortSignal>(resolve => { entered = resolve })
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const req = new Request(input, init)
      rejectPending = reject
      req.signal.addEventListener('abort', () => reject(new Error('private-revoke-timeout')), { once: true })
      entered(req.signal)
    }))
    const pending = request(operation === 'delete' ? 'DELETE' : 'POST', operation === 'delete' ? `/providers/${id}` : `/providers/${id}/codex/disconnect`)
    try {
      const signal = await started
      await vi.advanceTimersByTimeAsync(30_000)
      expect(signal.aborted).toBe(true)
      expect((await pending).status).toBe(204)
      expect(await store.read(id)).toEqual(operation === 'delete' ? null : expect.objectContaining({ status: 'disconnected', bundle: null }))
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private-revoke-timeout')
    } finally { rejectPending(new Error('fixture cleanup')); await pending }
  })

  it('refreshes the catalog through hub credentials and leaves newly discovered models disabled', async () => {
    const result = await poll((await start()).flow_id)
    if (result.status !== 'complete') throw new Error('Missing provider')
    const upstream = globalThis.fetch
    let authorization: string | null = null
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      if (!req.url.endsWith('/models')) return upstream(input, init)
      authorization = req.headers.get('authorization')
      return Response.json({ models: [{ slug: 'codex-test' }, { slug: 'codex-new' }] })
    })
    const response = await request('POST', `/providers/${result.provider.id}/fetch-models`)
    expect(response.status).toBe(200)
    expect(authorization).toBe('Bearer private-access')
    const rows = await db.query.models.findMany()
    expect(rows.find(row => row.model_id === 'codex-test')).toMatchObject({ enabled: true })
    expect(rows.find(row => row.model_id === 'codex-new')).toMatchObject({ enabled: false })
  })

  it('shares one refresh among concurrent callers and retains the connection version', async () => {
    const result = await poll((await start()).flow_id)
    if (result.status !== 'complete') throw new Error('Missing provider')
    await runInDurableObject(stub(), async (instance: UserHub) => {
      const id = result.provider.id
      const original = (await store.read(id))!
      await store.storeRefresh(original, { ...original.bundle!, expiresAt: Date.now() + 1 }, Date.now())
      const requests: unknown[] = []
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init)
        requests.push(await req.json())
        return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 })
      })
      const snapshots = await Promise.all(Array.from({ length: 8 }, () => instance.app.codex.getValidCredentials(id)))
      expect(requests).toEqual([{ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', grant_type: 'refresh_token', refresh_token: 'private-refresh' }])
      for (const snapshot of snapshots) expect(snapshot).toMatchObject({ status: 'connected', revision: 3, credentialVersion: 1, bundle: { accessToken: 'rotated-access', refreshToken: 'rotated-refresh' } })
      expect(await instance.app.codex.getValidCredentials(id)).toEqual(snapshots[0])
      expect(requests).toHaveLength(1)
    })
  })

  it.each(['disconnected', 'reconnect-required'] as const)('refuses model listing and token refresh for a %s connection', async status => {
    const result = await poll((await start()).flow_id)
    if (result.status !== 'complete') throw new Error('Missing provider')
    const original = (await store.read(result.provider.id))!
    if (status === 'disconnected') await store.disconnect(result.provider.id, original.revision, Date.now())
    else await store.markReconnectRequired(original, 'Reconnect required', Date.now())
    calls.length = 0
    const response = await request('POST', `/providers/${result.provider.id}/fetch-models`)
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'Codex model listing failed' })
    await runInDurableObject(stub(), async (instance: UserHub) => {
      await expect(instance.app.codex.getValidCredentials(result.provider.id, true)).rejects.toThrow(/reconnect/i)
      await expect(instance.app.codex.getValidCredentials(-1)).rejects.toThrow(/reconnect/i)
    })
    expect(calls).toEqual([])
    expect(await store.read(result.provider.id)).toMatchObject({ status })
    expect(await db.query.models.findMany()).toMatchObject([{ model_id: 'codex-test', enabled: true }])
  })

  it.each(['reconnect', 'disconnect', 'rotation'] as const)('discards refresh completion after a concurrent %s', async change => {
    const result = await poll((await start()).flow_id)
    if (result.status !== 'complete') throw new Error('Missing provider')
    await runInDurableObject(stub(), async (instance: UserHub) => {
      const id = result.provider.id
      const original = (await store.read(id))!
      vi.stubGlobal('fetch', async () => {
        const winner = { ...original.bundle!, accessToken: 'winning-access', expiresAt: Date.now() + 3_600_000 }
        if (change === 'reconnect') await store.reconnect(id, original.revision, winner, Date.now())
        else if (change === 'disconnect') await store.disconnect(id, original.revision, Date.now())
        else await store.storeRefresh(original, winner, Date.now())
        return Response.json({ access_token: 'stale-access', expires_in: 3600 })
      })
      const refreshing = instance.app.codex.getValidCredentials(id, true)
      if (change === 'disconnect') await expect(refreshing).rejects.toThrow(/reconnect/i)
      else expect(await refreshing).toMatchObject({ bundle: { accessToken: 'winning-access' } })
      expect(await store.read(id)).toMatchObject(change === 'disconnect' ? { status: 'disconnected', bundle: null } : { bundle: { accessToken: 'winning-access' } })
    })
  })

  it.each([400, 401, 429, 500])('only permanent refresh failures require reconnect (HTTP %s)', async status => {
    const result = await poll((await start()).flow_id)
    if (result.status !== 'complete') throw new Error('Missing provider')
    await runInDurableObject(stub(), async (instance: UserHub) => {
      vi.stubGlobal('fetch', async () => Response.json({ error: status === 400 ? 'invalid_grant' : 'private-upstream', detail: 'private-access' }, { status }))
      await expect(instance.app.codex.getValidCredentials(result.provider.id, true)).rejects.toThrow(/Codex/)
      const current = (await store.read(result.provider.id))!
      expect(current.status).toBe(status < 429 ? 'reconnect-required' : 'connected')
      const row = await db.query.providerOAuthCredentials.findFirst()
      expect(row?.last_error).toBe(status < 429 ? `Codex token refresh failed (${status})` : null)
      expect(JSON.stringify(row?.last_error)).not.toMatch(/private-/)
    })
  })

  it('ignores a permanent refresh failure from credentials superseded by reconnect', async () => {
    const result = await poll((await start()).flow_id)
    if (result.status !== 'complete') throw new Error('Missing provider')
    await runInDurableObject(stub(), async (instance: UserHub) => {
      const id = result.provider.id
      const original = (await store.read(id))!
      vi.stubGlobal('fetch', async () => {
        await store.reconnect(id, original.revision, { ...original.bundle!, accessToken: 'winning-access' }, Date.now())
        return Response.json({ error: 'invalid_grant' }, { status: 400 })
      })
      expect(await instance.app.codex.getValidCredentials(id, true)).toMatchObject({ status: 'connected', bundle: { accessToken: 'winning-access' } })
      expect(await db.query.providerOAuthCredentials.findFirst()).toMatchObject({ status: 'connected', last_error: null })
    })
  })

  it('clears a failed refresh so a later attempt can succeed', async () => {
    const result = await poll((await start()).flow_id)
    if (result.status !== 'complete') throw new Error('Missing provider')
    await runInDurableObject(stub(), async (instance: UserHub) => {
      let attempts = 0
      vi.stubGlobal('fetch', async () => ++attempts === 1
        ? Response.json({ error: 'private-transient' }, { status: 500 })
        : Response.json({ access_token: 'recovered-access', expires_in: 3600 }))
      await expect(instance.app.codex.getValidCredentials(result.provider.id, true)).rejects.toThrow(/Codex/)
      expect(await instance.app.codex.getValidCredentials(result.provider.id, true)).toMatchObject({ status: 'connected', bundle: { accessToken: 'recovered-access' } })
      expect(attempts).toBe(2)
    })
  })

  it.each(['refresh', 'models'] as const)('aborts stalled %s requests after 30 seconds and retains the connection', async operation => {
    const result = await poll((await start()).flow_id)
    if (result.status !== 'complete') throw new Error('Missing provider')
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    await runInDurableObject(stub(), async (instance: UserHub) => {
      let entered!: (signal: AbortSignal) => void
      let rejectPending!: (error: Error) => void
      const started = new Promise<AbortSignal>(resolve => { entered = resolve })
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        const req = new Request(input, init)
        rejectPending = reject
        req.signal.addEventListener('abort', () => reject(new Error('private-timeout-detail')), { once: true })
        entered(req.signal)
      }))
      const pending = (operation === 'refresh' ? instance.app.codex.getValidCredentials(result.provider.id, true) : instance.app.codex.listModels(result.provider.id))
        .then(() => null, error => error as Error)
      try {
        const signal = await started
        await vi.advanceTimersByTimeAsync(29_999)
        expect(signal.aborted).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(signal.aborted).toBe(true)
        expect(await pending).toBeInstanceOf(Error)
        expect((await pending)?.message).not.toContain('private-timeout-detail')
        expect(await store.read(result.provider.id)).toMatchObject({ status: 'connected', revision: 1 })
      } finally { rejectPending(new Error('fixture cleanup')); await pending }
    })
  })

  it('stores only encrypted pending secrets and creates an enabled model only after completion', async () => {
    const grant = await start()
    expect(await db.select().from(providers)).toEqual([])
    await runInDurableObject(stub(), async (_instance: UserHub, state) => {
      const record = await state.storage.get(`codex-oauth:${grant.flow_id}`)
      expect(JSON.stringify(record)).not.toMatch(/private-device|PRIVATE-CODE/)
      expect(await decryptJson(env.KEY_ENCRYPTION_SECRET, record as string)).toMatchObject({ deviceAuthId: 'private-device', userCode: 'PRIVATE-CODE' })
    })
    const result = await poll(grant.flow_id)
    expect(result).toMatchObject({ status: 'complete', provider: { kind: 'codex-oauth', has_key: false, oauth: { status: 'connected', account_email: 'owner@example.com' } } })
    expect(JSON.stringify(result)).not.toMatch(/private-account|private-access|private-refresh|encrypted_bundle|account_id|id_token/)
    expect(await db.query.models.findMany()).toMatchObject([{ model_id: 'codex-test', enabled: true }])
    expect(await poll(grant.flow_id)).toMatchObject({ status: 'failed' })
    const list = await (await request('GET', '/providers')).json()
    expect(list).toEqual(result.status === 'complete' ? [result.provider] : [])
  })

  it('throttles early polls without making another upstream call', async () => {
    authorized = false
    const grant = await start()
    const first = await poll(grant.flow_id)
    expect(first).toMatchObject({ status: 'pending' })
    expect(await poll(grant.flow_id)).toEqual(first)
    expect(calls.filter(url => url.endsWith('/deviceauth/token'))).toHaveLength(1)
    expect(await db.select().from(providers)).toEqual([])
  })

  it('allows only one in-flight poll and cancellation prevents late authorization from creating credentials', async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    pollWait = () => { entered(); return gate }
    const grant = await start()
    const first = poll(grant.flow_id)
    await started
    expect(await poll(grant.flow_id)).toMatchObject({ status: 'pending' })
    expect((await request('DELETE', `/codex/oauth/${grant.flow_id}`)).status).toBe(204)
    release()
    expect(await first).toMatchObject({ status: 'failed' })
    expect(calls.filter(url => url.endsWith('/deviceauth/token'))).toHaveLength(1)
    expect(calls.filter(url => url.endsWith('/oauth/token'))).toHaveLength(0)
    expect(await db.select().from(providers)).toEqual([])
  })

  it('rejects expiration during a pending upstream request instead of extending the flow', async () => {
    authorized = false
    const grant = await start()
    pollWait = async () => {
      await runInDurableObject(stub(), async (_instance: UserHub, state) => {
        const key = `codex-oauth:${grant.flow_id}`
        const flow = await decryptJson<Record<string, unknown>>(env.KEY_ENCRYPTION_SECRET, (await state.storage.get<string>(key))!)
        await state.storage.put(key, await encryptJson(env.KEY_ENCRYPTION_SECRET, { ...flow, expiresAt: Date.now() - 1 }))
      })
    }
    expect(await poll(grant.flow_id)).toMatchObject({ status: 'failed' })
  })

  it('cancels pending flows and expires timed-out flows before calling upstream', async () => {
    const cancelled = await start()
    expect((await request('DELETE', `/codex/oauth/${cancelled.flow_id}`)).status).toBe(204)
    expect(await poll(cancelled.flow_id)).toMatchObject({ status: 'failed' })
    const expired = await start()
    await runInDurableObject(stub(), async (_instance: UserHub, state) => {
      const key = `codex-oauth:${expired.flow_id}`
      const flow = await decryptJson<Record<string, unknown>>(env.KEY_ENCRYPTION_SECRET, (await state.storage.get<string>(key))!)
      await state.storage.put(key, await encryptJson(env.KEY_ENCRYPTION_SECRET, { ...flow, expiresAt: Date.now() - 1 }))
    })
    expect(await poll(expired.flow_id)).toMatchObject({ status: 'failed' })
    expect(calls.filter(url => url.endsWith('/deviceauth/token'))).toHaveLength(0)
    await runInDurableObject(stub(), async (_instance: UserHub, state) => {
      expect(await state.storage.get(`codex-oauth:${expired.flow_id}`)).toBeUndefined()
    })
  })

  it('rejects duplicate accounts while retaining the existing provider', async () => {
    const first = await poll((await start()).flow_id)
    expect(first.status).toBe('complete')
    expect(await poll((await start()).flow_id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/already|duplicate/i) })
    expect(await db.select().from(providers)).toHaveLength(1)
  })

  it('requires the same reconnect account and leaves newly found reconnect models disabled', async () => {
    const first = await poll((await start()).flow_id)
    if (first.status !== 'complete') throw new Error('Missing provider')
    const id = first.provider.id
    const before = await store.read(id)
    accountId = 'wrong-account'
    expect(await poll((await start(`/providers/${id}/codex/reconnect`)).flow_id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/same.*account/i) })
    expect(await store.read(id)).toEqual(before)
    accountId = 'private-account'
    await env.DB.prepare('DELETE FROM models WHERE provider_id = ?').bind(id).run()
    expect(await poll((await start(`/providers/${id}/codex/reconnect`)).flow_id)).toMatchObject({ status: 'complete', provider: { id, credential_version: 2 } })
    expect(await db.query.models.findMany()).toMatchObject([{ model_id: 'codex-test', enabled: false }])
  })

  it('enables initial models when reconnect commits while the initial model listing is pending', async () => {
    const upstream = globalThis.fetch
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    let firstListing = true
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Request(input, init).url.endsWith('/models')) {
        if (!firstListing) return Response.json({ models: [{ slug: 'reconnect-model' }] })
        firstListing = false
        entered()
        await gate
        return Response.json({ models: [{ slug: 'initial-model' }, { slug: 'reconnect-model' }] })
      }
      return upstream(input, init)
    })
    const initial = poll((await start()).flow_id)
    try {
      await started
      const provider = (await db.select().from(providers))[0]!
      expect(await poll((await start(`/providers/${provider.id}/codex/reconnect`)).flow_id)).toMatchObject({ status: 'complete', provider: { credential_version: 2 } })
      release()
      expect(await initial).toMatchObject({ status: 'complete' })
      const rows = await db.query.models.findMany()
      expect(rows.find(row => row.model_id === 'initial-model')).toMatchObject({ enabled: true })
      expect(rows.find(row => row.model_id === 'reconnect-model')).toMatchObject({ enabled: false })
    } finally { release(); await initial }
  })

  it.each([
    { path: '/deviceauth/token', lifetime: 900_000, deadline: 30_000 },
    { path: '/oauth/token', lifetime: 900_000, deadline: 30_000 },
    { path: '/deviceauth/token', lifetime: 1250, deadline: 1250 },
    { path: '/oauth/token', lifetime: 1250, deadline: 1250 },
    { path: '/models', lifetime: 900_000, deadline: 30_000 },
  ])('aborts stalled $path after $deadline ms with flow lifetime $lifetime ms', async ({ path, lifetime, deadline }) => {
    const grant = await start()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    await runInDurableObject(stub(), async (instance: UserHub) => {
      const flow = (await instance.app.codex.flows.read(grant.flow_id, Date.now()))!
      await instance.app.codex.flows.update({ ...flow, expiresAt: Date.now() + lifetime })
    })
    const upstream = globalThis.fetch
    let rejectPending!: (reason: Error) => void
    let entered!: (signal: AbortSignal) => void
    const started = new Promise<AbortSignal>(resolve => { entered = resolve })
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      if (!req.url.endsWith(path)) return upstream(input, init)
      return new Promise<Response>((_resolve, reject) => {
        rejectPending = reject
        req.signal.addEventListener('abort', () => reject(new Error('private-abort-detail')), { once: true })
        entered(req.signal)
      })
    })
    const operation = poll(grant.flow_id)
    try {
      const signal = await started
      await vi.advanceTimersByTimeAsync(deadline - 1)
      expect(signal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(signal.aborted).toBe(true)
      const result = await operation
      expect(result).toMatchObject(path === '/models'
        ? { status: 'complete', provider: { oauth: { status: 'connected' } }, model_sync_warning: expect.any(String) }
        : { status: 'failed' })
      expect(JSON.stringify(result)).not.toMatch(/private-abort-detail|private-access|private-refresh/)
      expect(await db.select().from(providers)).toHaveLength(path === '/models' ? 1 : 0)
      expect(await poll(grant.flow_id)).toMatchObject({ status: 'failed' })
    } finally {
      rejectPending(new Error('fixture cleanup'))
      await operation
    }
  })

  it('aborts stalled authorization starts after 30 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    let rejectPending!: (reason: Error) => void
    let entered!: (signal: AbortSignal) => void
    const started = new Promise<AbortSignal>(resolve => { entered = resolve })
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const req = new Request(input, init)
      rejectPending = reject
      req.signal.addEventListener('abort', () => reject(new Error('private-abort-detail')), { once: true })
      entered(req.signal)
    }))
    const operation = request('POST', '/codex/oauth/start')
    try {
      const signal = await started
      await vi.advanceTimersByTimeAsync(29_999)
      expect(signal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(signal.aborted).toBe(true)
      const response = await operation
      expect(response.status).toBe(502)
      expect(await response.text()).not.toContain('private-abort-detail')
      expect(await db.select().from(providers)).toEqual([])
    } finally { rejectPending(new Error('fixture cleanup')); await operation }
  })

  it('retains credentials and returns a sanitized warning when model listing fails', async () => {
    modelFailure = true
    const result = await poll((await start()).flow_id)
    expect(result).toMatchObject({ status: 'complete', model_sync_warning: expect.any(String), provider: { oauth: { status: 'connected' } } })
    expect(JSON.stringify(result)).not.toMatch(/private-upstream-body|private-access|private-refresh/)
    expect(await db.select().from(providers)).toHaveLength(1)
  })

  it('terminates denied polls and sanitizes authorization request failures', async () => {
    const grant = await start()
    vi.stubGlobal('fetch', async () => Response.json({ error: 'private-denial-body' }, { status: 400 }))
    const denied = await poll(grant.flow_id)
    expect(denied).toMatchObject({ status: 'failed' })
    expect(JSON.stringify(denied)).not.toContain('private-denial-body')
    expect(await poll(grant.flow_id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/expired|cancelled/i) })
    const failedStart = await request('POST', '/codex/oauth/start')
    expect(failedStart.status).toBe(502)
    expect(await failedStart.text()).not.toContain('private-denial-body')
    expect(await db.select().from(providers)).toEqual([])
  })

  it('projects reconnect-required and disconnected summaries without credentials', async () => {
    const result = await poll((await start()).flow_id)
    if (result.status !== 'complete') throw new Error('Missing provider')
    const snapshot = (await store.read(result.provider.id))!
    await store.markReconnectRequired(snapshot, 'Reconnect required', Date.now())
    const reconnect = await (await request('GET', '/providers')).json()
    expect(reconnect).toMatchObject([{ kind: 'codex-oauth', oauth: { status: 'reconnect-required', last_error: 'Reconnect required' } }])
    expect(JSON.stringify(reconnect)).not.toMatch(/encrypted_bundle|account_id|private-access|private-refresh/)
    expect(await store.disconnect(result.provider.id, 2, Date.now())).toBe(true)
    const disconnected = await (await request('GET', '/providers')).json()
    expect(disconnected).toMatchObject([{ kind: 'codex-oauth', oauth: { status: 'disconnected', account_email: 'owner@example.com', access_expires_at: null, last_error: null } }])
    expect(JSON.stringify(disconnected)).not.toMatch(/encrypted_bundle|account_id|private-access|private-refresh/)
  })

  it('retains credentials and sanitizes reconciliation failures', async () => {
    await env.DB.prepare("CREATE TRIGGER reject_oauth_model BEFORE INSERT ON models BEGIN SELECT RAISE(ABORT, 'private-sync-body'); END").run()
    try {
      const result = await poll((await start()).flow_id)
      expect(result).toMatchObject({ status: 'complete', model_sync_warning: expect.any(String) })
      expect(JSON.stringify(result)).not.toContain('private-sync-body')
      expect(await db.select().from(providers)).toHaveLength(1)
    } finally { await env.DB.prepare('DROP TRIGGER reject_oauth_model').run() }
  })

  it('rejects invalid and missing reconnect providers before requesting authorization', async () => {
    expect((await request('POST', '/providers/no/codex/reconnect')).status).toBe(404)
    expect((await request('POST', '/providers/99999/codex/reconnect')).status).toBe(404)
    expect(calls).toEqual([])
  })
})
