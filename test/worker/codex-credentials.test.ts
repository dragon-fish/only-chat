import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { models, providerInterfaces, providerOAuthCredentials, providers, users } from '@/server/db/schema'
import { CodexCredentialStore } from '@/server/plugins/codex/credentials'
import type { CodexTokenBundle } from '@/server/plugins/codex/types'
import { encryptJson } from '@/server/plugins/llm/crypto'

const db = createDb(env.DB)
const store = new CodexCredentialStore(db, env.KEY_ENCRYPTION_SECRET)
const bundle: CodexTokenBundle = {
  idToken: 'private-id-token', accessToken: 'private-access-token', refreshToken: 'private-refresh-token',
  tokenType: 'Bearer', accountId: 'account-1', email: 'owner@example.com', expiresAt: 100_000,
}
const rotated = { ...bundle, accessToken: 'rotated-access-token', refreshToken: 'rotated-refresh-token', expiresAt: 200_000 }
const provider = (id: number) => db.query.providers.findFirst({ where: eq(providers.id, id) })
const credential = (id: number) => db.query.providerOAuthCredentials.findFirst({ where: eq(providerOAuthCredentials.provider_id, id) })

beforeEach(async () => {
  await db.delete(providers)
  await db.insert(users).values({ id: 1, name: 'owner', settings: { plugins: {} }, created_at: 0 }).onConflictDoNothing()
})

describe('Codex credential persistence', () => {
  it('creates the provider, fixed interface, default link and encrypted credential together', async () => {
    const id = await store.createProvider(bundle, 10)
    const row = await provider(id)
    expect(row).toMatchObject({ user_id: 1, kind: 'codex-oauth', api_key: null, credential_version: 1 })
    const interfaces = await db.select().from(providerInterfaces).where(eq(providerInterfaces.provider_id, id))
    expect(interfaces).toHaveLength(1)
    expect(interfaces[0]).toMatchObject({ id: row!.default_interface_id, protocol: 'responses', base_url: 'https://chatgpt.com/backend-api/codex', native_files: false })
    const stored = await credential(id)
    for (const token of [bundle.accessToken, bundle.refreshToken, bundle.idToken]) expect(JSON.stringify(stored)).not.toContain(token)
    expect(await store.read(id)).toMatchObject({ providerId: id, bundle, revision: 1, credentialVersion: 1, status: 'connected' })
    expect(stored).toMatchObject({ account_id: bundle.accountId, account_email: bundle.email, access_expires_at: 100_000, updated_at: 10 })
  })

  it('rolls back the provider and interface when credential insertion fails', async () => {
    await env.DB.prepare("CREATE TRIGGER reject_codex_credentials BEFORE INSERT ON provider_oauth_credentials BEGIN SELECT RAISE(ABORT, 'fixture failure'); END").run()
    try {
      await expect(store.createProvider(bundle, 10)).rejects.toThrow()
      expect(await db.select().from(providers)).toEqual([])
      expect(await db.select().from(providerInterfaces)).toEqual([])
    } finally {
      await env.DB.prepare('DROP TRIGGER reject_codex_credentials').run()
    }
  })

  it('rejects duplicate creation even when two calls overlap', async () => {
    const results = await Promise.allSettled([store.createProvider(bundle, 10), store.createProvider(bundle, 11)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason.message).toMatch(/already|duplicate/i)
    expect(await db.select().from(providers)).toHaveLength(1)
    expect(await db.select().from(providerInterfaces)).toHaveLength(1)
    expect(await db.select().from(providerOAuthCredentials)).toHaveLength(1)
  })

  it('allows another Only Chat user to have the same account and isolates reads and writes', async () => {
    await db.insert(users).values({ id: 2, name: 'other', settings: { plugins: {} }, created_at: 0 }).onConflictDoNothing()
    const [other] = await db.insert(providers).values({ user_id: 2, name: 'other', kind: 'codex-oauth', created_at: 0 }).returning()
    await db.insert(providerOAuthCredentials).values({ provider_id: other!.id, status: 'connected', encrypted_bundle: await encryptJson(env.KEY_ENCRYPTION_SECRET, bundle), account_id: bundle.accountId, account_email: bundle.email, updated_at: 0 })
    const id = await store.createProvider(bundle, 10)
    expect(id).not.toBe(other!.id)
    expect(await store.read(other!.id)).toBeNull()
    expect(await store.disconnect(other!.id, 1, 20)).toBe(false)
    await expect(store.reconnect(other!.id, 1, rotated, 20)).rejects.toThrow()
    const forged = { ...(await store.read(id))!, status: 'connected' as const, bundle, providerId: other!.id, encryptedBundle: (await credential(other!.id))!.encrypted_bundle! }
    expect(await store.storeRefresh(forged, rotated, 20)).toBe(false)
    expect(await store.markReconnectRequired(forged, 'Reconnect required', 20)).toBe(false)
    expect(await credential(other!.id)).toMatchObject({ revision: 1, status: 'connected' })
  })

  it('keeps disconnected accounts reserved for same-provider reconnect', async () => {
    const id = await store.createProvider(bundle, 10)
    await store.disconnect(id, 1, 20)
    await expect(store.createProvider(bundle, 30)).rejects.toThrow(/already|duplicate/i)
    await store.reconnect(id, 2, rotated, 40)
    expect(await store.read(id)).toMatchObject({ bundle: rotated, revision: 3, credentialVersion: 3, status: 'connected' })
  })

  it('reconnects the same account without changing a customized provider or its models', async () => {
    const id = await store.createProvider(bundle, 10)
    await db.update(providers).set({ name: 'My account', enabled: false }).where(eq(providers.id, id))
    const [model] = await db.insert(models).values({ provider_id: id, model_id: 'gpt-test' }).returning()
    await store.reconnect(id, 1, { ...rotated, email: 'updated@example.com' }, 20)
    expect(await store.read(id)).toMatchObject({ revision: 2, credentialVersion: 2, status: 'connected', bundle: { email: 'updated@example.com' } })
    expect(await provider(id)).toMatchObject({ name: 'My account', enabled: false })
    expect(await credential(id)).toMatchObject({ account_email: 'updated@example.com', last_error: null, updated_at: 20 })
    expect(await db.query.models.findFirst({ where: eq(models.id, model!.id) })).toEqual(model)
  })

  it('rejects a different account and stale reconnect without changing credentials', async () => {
    const id = await store.createProvider(bundle, 10)
    await expect(store.reconnect(id, 1, { ...rotated, accountId: 'other-account' }, 20)).rejects.toThrow(/account/i)
    await expect(store.reconnect(id, 0, rotated, 20)).rejects.toThrow(/changed|conflict|stale/i)
    expect(await store.read(id)).toMatchObject({ bundle, revision: 1, credentialVersion: 1 })
  })

  it('allows only one overlapping reconnect to replace a connection', async () => {
    const id = await store.createProvider(bundle, 10)
    const results = await Promise.allSettled([
      store.reconnect(id, 1, rotated, 20),
      store.reconnect(id, 1, { ...rotated, accessToken: 'other-reconnect' }, 21),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await store.read(id)).toMatchObject({
      revision: 2, credentialVersion: 2,
      bundle: { accessToken: results[0]!.status === 'fulfilled' ? rotated.accessToken : 'other-reconnect' },
    })
  })

  it.each(['reconnect', 'disconnect'] as const)('rolls back the connection version if %s credential writing fails', async (operation) => {
    const id = await store.createProvider(bundle, 10)
    const before = await store.read(id)
    await env.DB.prepare("CREATE TRIGGER reject_codex_update BEFORE UPDATE ON provider_oauth_credentials BEGIN SELECT RAISE(ABORT, 'fixture failure'); END").run()
    try {
      await expect(operation === 'reconnect' ? store.reconnect(id, 1, rotated, 20) : store.disconnect(id, 1, 20)).rejects.toThrow()
      expect(await store.read(id)).toEqual(before)
    } finally {
      await env.DB.prepare('DROP TRIGGER reject_codex_update').run()
    }
  })

  it('rotates once with revision CAS while preserving the connection version', async () => {
    const id = await store.createProvider(bundle, 10)
    const snapshot = (await store.read(id))!
    const results = await Promise.all([store.storeRefresh(snapshot, rotated, 20), store.storeRefresh(snapshot, { ...rotated, accessToken: 'other-rotation' }, 21)])
    expect([...results].sort()).toEqual([false, true])
    const current = (await store.read(id))!
    expect(current).toMatchObject({ revision: 2, credentialVersion: 1, status: 'connected' })
    expect(current.bundle!.accessToken).toBe(results[0] ? rotated.accessToken : 'other-rotation')
    expect(await store.markReconnectRequired(snapshot, 'Reconnect required', 30)).toBe(false)
    expect(await store.read(id)).toEqual(current)
  })

  it('rejects refreshes that try to replace the connected account', async () => {
    const id = await store.createProvider(bundle, 10)
    await expect(store.storeRefresh((await store.read(id))!, { ...rotated, accountId: 'other-account' }, 20)).rejects.toThrow(/account/i)
    expect(await store.read(id)).toMatchObject({ bundle, revision: 1 })
  })

  it('compares ciphertext as well as revision on refresh and terminal failure', async () => {
    const id = await store.createProvider(bundle, 10)
    const snapshot = (await store.read(id))!
    await db.update(providerOAuthCredentials).set({ encrypted_bundle: await encryptJson(env.KEY_ENCRYPTION_SECRET, rotated) }).where(eq(providerOAuthCredentials.provider_id, id))
    expect(await store.storeRefresh(snapshot, bundle, 20)).toBe(false)
    expect(await store.markReconnectRequired(snapshot, 'Reconnect required', 20)).toBe(false)
    expect(await store.disconnect(id, snapshot.revision, 20, snapshot.encryptedBundle)).toBe(false)
    expect(await store.read(id)).toMatchObject({ bundle: rotated, revision: 1, status: 'connected' })
  })

  it('retains the encrypted bundle on permanent failure and requires reconnect to recover', async () => {
    const id = await store.createProvider(bundle, 10)
    const snapshot = (await store.read(id))!
    expect(await store.markReconnectRequired(snapshot, 'Codex token refresh failed (401)', 20)).toBe(true)
    expect(await credential(id)).toMatchObject({ encrypted_bundle: snapshot.encryptedBundle, status: 'reconnect-required', last_error: 'Codex token refresh failed (401)', revision: 2 })
    expect(await provider(id)).toMatchObject({ credential_version: 1 })
    expect(await store.storeRefresh(snapshot, rotated, 30)).toBe(false)
    expect(await store.storeRefresh((await store.read(id))!, rotated, 30)).toBe(false)
    await store.reconnect(id, 2, rotated, 40)
    expect(await credential(id)).toMatchObject({ status: 'connected', last_error: null, revision: 3 })
    expect(await provider(id)).toMatchObject({ credential_version: 2 })
  })

  it('suppresses stale refresh and failure results after reconnect and disconnect', async () => {
    const id = await store.createProvider(bundle, 10)
    const old = (await store.read(id))!
    await store.reconnect(id, 1, rotated, 20)
    expect(await store.storeRefresh(old, bundle, 30)).toBe(false)
    expect(await store.markReconnectRequired(old, 'Reconnect required', 30)).toBe(false)
    const current = (await store.read(id))!
    expect(await store.disconnect(id, 1, 40)).toBe(false)
    expect(await store.disconnect(id, 2, 40)).toBe(true)
    expect(await store.storeRefresh(current, bundle, 50)).toBe(false)
    expect(await store.markReconnectRequired(current, 'Reconnect required', 50)).toBe(false)
    expect(await credential(id)).toMatchObject({ status: 'disconnected', encrypted_bundle: null, access_expires_at: null, last_error: null, revision: 3 })
    expect(await store.read(id)).toMatchObject({ bundle: null, credentialVersion: 3 })
  })

  it('disconnects once when requests overlap, preserving models and provider settings', async () => {
    const id = await store.createProvider(bundle, 10)
    const row = await provider(id)
    const [model] = await db.insert(models).values({ provider_id: id, model_id: 'gpt-test' }).returning()
    expect((await Promise.all([store.disconnect(id, 1, 20), store.disconnect(id, 1, 21)])).sort()).toEqual([false, true])
    expect(await provider(id)).toEqual({ ...row, credential_version: 2 })
    expect(await db.query.models.findFirst({ where: eq(models.id, model!.id) })).toEqual(model)
    expect(await store.disconnect(id, 2, 30)).toBe(false)
    expect(await store.disconnect(-1, 1, 30)).toBe(false)
    expect(await store.read(-1)).toBeNull()
  })
})
