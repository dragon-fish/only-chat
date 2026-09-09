import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/server/app'
import { models, providerInterfaces, providers } from '@/server/db/schema'
import { CatalogLease } from '@/server/plugins/model-catalog/lease'
import { ensureTestUser, authenticatedRequest } from './auth-helper'

beforeEach(async () => { await ensureTestUser() })

function catalog(name = 'Catalog model') {
  return {
    providers: {
      acme: { id: 'acme', name: 'Acme', api: 'https://acme.test/v1', models: {
        'acme/model': { id: 'acme/model', name, reasoning: true, tool_call: true,
          modalities: { input: ['text', 'image'], output: ['text'] }, limit: { context: 1000, output: 100 } },
        'not-installed': { id: 'not-installed', name: 'Do not import' },
      } },
    },
    models: { 'acme/model': { id: 'acme/model', name: 'Global model' } },
  }
}

function serve(body: unknown = catalog(), status = 200) {
  vi.stubGlobal('fetch', async (url: string) => {
    expect(url).toBe('https://models.dev/catalog.json')
    return Response.json(body, { status })
  })
}

function pauseStaging() {
  let release!: () => void
  let signal!: () => void
  const resume = new Promise<void>(resolve => { release = resolve })
  const paused = new Promise<void>(resolve => { signal = resolve })
  const kv = new Proxy(env.KV, {
    get(target, property) {
      if (property === 'put') return async (key: string, value: string, options?: KVNamespacePutOptions) => {
        if (key.endsWith(':manifest')) { signal(); await resume }
        return target.put(key, value, options)
      }
      const member = Reflect.get(target, property)
      return typeof member === 'function' ? member.bind(target) : member
    },
  })
  return { kv, paused, release }
}

async function seedLeasedModel() {
  const ctx = await createApp({ env, side: 'worker' })
  const [provider] = await ctx.db.orm.insert(providers).values({ user_id: 1, name: 'lease', models_dev_provider_id: 'acme', models_dev_provider_source: 'manual', created_at: 0 }).returning()
  const [model] = await ctx.db.orm.insert(models).values({ provider_id: provider!.id, model_id: 'acme/model' }).returning()
  return { ctx, model: model! }
}

async function clearCatalog() {
  await env.DB.exec('DELETE FROM model_catalog_refresh')
  const listed = await env.KV.list()
  await Promise.all(listed.keys.map(key => env.KV.delete(key.name)))
}

async function publication() {
  return env.DB.prepare('SELECT current_version AS current, previous_version AS previous FROM model_catalog_refresh WHERE current_version IS NOT NULL').first<{ current: string; previous: string | null }>()
}

beforeEach(clearCatalog)
afterEach(() => vi.unstubAllGlobals())

describe('model catalog', () => {
  it('keeps the newer publication when an expired publisher resumes after the publication boundary', async () => {
    const { ctx, model } = await seedLeasedModel()
    serve()
    await ctx.modelCatalog.refresh('manual')
    let release!: () => void
    let signal!: () => void
    const resume = new Promise<void>(resolve => { release = resolve })
    const paused = new Promise<void>(resolve => { signal = resolve })
    const delayedDB = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
          const committed = await target.batch(statements)
          signal()
          await resume
          return committed
        }
        const member = Reflect.get(target, property)
        return typeof member === 'function' ? member.bind(target) : member
      },
    })
    const delayed = await createApp({ env: { ...env, DB: delayedDB }, side: 'worker' })
    serve(catalog('Delayed'))
    const pending = delayed.modelCatalog.refresh('manual')
    await paused
    const previous = await publication()
    let winner
    let winnerStatus
    try {
      await env.DB.exec('UPDATE model_catalog_refresh SET expires_at = 0 WHERE id = 1')
      const winningCatalog = catalog('Winner')
      winningCatalog.providers.acme.name = 'Winner provider'
      winningCatalog.models['acme/model'].name = 'Winner global'
      serve(winningCatalog)
      winner = await ctx.modelCatalog.refresh('manual')
      winnerStatus = await ctx.modelCatalog.status()
    } finally {
      release()
      await pending
    }
    expect((await ctx.db.orm.select().from(models).where(eq(models.id, model.id)))[0]?.metadata_resolved.name).toBe('Winner')
    expect(await publication()).toEqual({ current: winner.version, previous: previous!.current })
    expect(await delayed.modelCatalog.status()).toEqual(winnerStatus)
    expect((await delayed.modelCatalog.providerIndex()).acme?.name).toBe('Winner provider')
    expect((await delayed.modelCatalog.globalModels(winner.version))['acme/model']?.name).toBe('Winner global')
    expect((await delayed.modelCatalog.providerModels('acme', winner.version))['acme/model']?.name).toBe('Winner')
    expect(await env.KV.get('models-dev:active')).toBeNull()
    expect(await env.KV.get('models-dev:status')).toBeNull()
  })

  it('reclaims an expired lease and fences commits and release by its previous owner', async () => {
    const ctx = await createApp({ env, side: 'worker' })
    const stale = await CatalogLease.acquire(ctx.db.orm)
    await env.DB.exec('UPDATE model_catalog_refresh SET expires_at = 0 WHERE id = 1')
    const replacement = await CatalogLease.acquire(ctx.db.orm)
    try {
      await expect(stale.renew()).rejects.toThrow('lease expired')
      await expect(stale.commit([], { current: 'stale', previous: null })).rejects.toThrow()
      await stale.release()
      await expect(CatalogLease.acquire(ctx.db.orm)).rejects.toThrow('already in progress')
      await replacement.commit([], { current: 'replacement', previous: null })
      await expect(stale.recordUnchangedSuccess()).rejects.toThrow('lease expired')
      await stale.recordFailure('Stale failure')
      expect(await env.DB.prepare('SELECT current_version, last_error FROM model_catalog_refresh').first()).toEqual({ current_version: 'replacement', last_error: null })
    } finally {
      await replacement.release()
    }
  })

  it('bounds abandoned refresh leases to one minute', async () => {
    const ctx = await createApp({ env, side: 'worker' })
    const before = Date.now()
    const lease = await CatalogLease.acquire(ctx.db.orm)
    try {
      const state = await env.DB.prepare('SELECT expires_at FROM model_catalog_refresh WHERE id = 1').first<{ expires_at: number }>()
      expect(state!.expires_at - before).toBeGreaterThan(0)
      expect(state!.expires_at - before).toBeLessThanOrEqual(60_000)
    } finally { await lease.release() }
  })

  it('starts a replacement refresh in the same service after its database lease expires', async () => {
    const ctx = await createApp({ env, side: 'worker' })
    let startFirst!: () => void
    let releaseFirst!: () => void
    const firstStarted = new Promise<void>(resolve => { startFirst = resolve })
    const firstResume = new Promise<void>(resolve => { releaseFirst = resolve })
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      if (calls === 1) { startFirst(); await firstResume }
      return Response.json(catalog(calls === 1 ? 'Abandoned' : 'Replacement'))
    })
    const abandoned = ctx.modelCatalog.refresh('manual')
    await firstStarted
    await env.DB.exec('UPDATE model_catalog_refresh SET expires_at = 0 WHERE id = 1')
    const replacement = ctx.modelCatalog.refresh('manual')
    try {
      const result = await Promise.race([
        replacement,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('replacement refresh did not start')), 250)),
      ])
      expect(result).toMatchObject({ changed: true })
      expect(calls).toBe(2)
    } finally {
      releaseFirst()
      await abandoned.catch(() => {})
    }
  })

  it('stops an expired publisher before materialization and preserves its successor lease', async () => {
    const { ctx, model } = await seedLeasedModel()
    serve()
    await ctx.modelCatalog.refresh('manual')
    const gate = pauseStaging()
    const stale = await createApp({ env: { ...env, KV: gate.kv }, side: 'worker' })
    serve(catalog('Stale owner'))
    const pending = stale.modelCatalog.refresh('manual')
    await gate.paused
    try {
      await env.DB.exec('UPDATE model_catalog_refresh SET expires_at = 0 WHERE id = 1')
      serve(catalog('Replacement owner'))
      const replacement = await ctx.modelCatalog.refresh('manual')
      const successor = await CatalogLease.acquire(ctx.db.orm)
      try {
        gate.release()
        await expect(pending).rejects.toThrow('lease expired')
        await expect(CatalogLease.acquire(ctx.db.orm)).rejects.toThrow('already in progress')
        expect((await ctx.db.orm.select().from(models).where(eq(models.id, model.id)))[0]?.metadata_resolved.name).toBe('Replacement owner')
        expect(await publication()).toMatchObject({ current: replacement.version })
        expect((await ctx.modelCatalog.status()).lastError).toBeNull()
      } finally {
        await successor.release()
      }
    } finally {
      gate.release()
      await pending.catch(() => {})
    }
  })

  it('serializes two service publishers and ignores stale KV publication pointers', async () => {
    const { ctx, model } = await seedLeasedModel()
    serve()
    const initial = await ctx.modelCatalog.refresh('manual')
    const gate = pauseStaging()
    const owner = await createApp({ env: { ...env, KV: gate.kv }, side: 'worker' })
    const staleKV = new Proxy(env.KV, {
      get(target, property) {
        if (property === 'get') return async (key: string, type: 'json') => key === 'models-dev:active'
          ? { current: initial.version, previous: null }
          : target.get(key, type)
        const member = Reflect.get(target, property)
        return typeof member === 'function' ? member.bind(target) : member
      },
    })
    const contender = await createApp({ env: { ...env, KV: staleKV }, side: 'worker' })
    serve(catalog('Owner version'))
    const publishing = owner.modelCatalog.refresh('manual')
    await gate.paused
    let published
    try {
      serve(catalog('Contender version'))
      const conflict = await authenticatedRequest(contender.api, '/api/model-catalog/refresh', { method: 'POST' })
      expect(conflict.status).toBe(202)
      expect(await conflict.json()).toHaveProperty('instanceId')
      expect(await contender.modelCatalog.refresh('cron')).toBeNull()
      expect((await ctx.db.orm.select().from(models).where(eq(models.id, model.id)))[0]?.metadata_resolved.name).toBe('Catalog model')
      expect(await publication()).toEqual({ current: initial.version, previous: null })
    } finally {
      gate.release()
      published = await publishing
    }
    expect((await ctx.db.orm.select().from(models).where(eq(models.id, model.id)))[0]?.metadata_resolved.name).toBe('Owner version')
    expect(await publication()).toEqual({ current: published.version, previous: initial.version })
    const last = await contender.modelCatalog.refresh('manual')
    expect((await ctx.db.orm.select().from(models).where(eq(models.id, model.id)))[0]?.metadata_resolved.name).toBe('Contender version')
    expect(await publication()).toEqual({ current: last.version, previous: published.version })
  })

  it('publishes immutable shards and keeps current plus previous', async () => {
    const ctx = await createApp({ env, side: 'worker' })
    serve()
    const first = await ctx.modelCatalog.refresh('manual')
    expect(first).toMatchObject({ changed: true, providers: 1, globalModels: 1, providerModels: 2 })
    const oldShard = await env.KV.get(`models-dev:${first.version}:provider:acme`)
    serve(catalog('Changed'))
    const second = await ctx.modelCatalog.refresh('manual')
    expect(second.version).not.toBe(first.version)
    expect(await publication()).toEqual({ current: second.version, previous: first.version })
    expect(await env.KV.get(`models-dev:${first.version}:provider:acme`)).toBe(oldShard)
    expect((await ctx.modelCatalog.providerIndex()).acme).toEqual({ id: 'acme', name: 'Acme', api: 'https://acme.test/v1' })
    expect((await ctx.modelCatalog.globalModels(second.version))['acme/model']?.name).toBe('Global model')
    expect((await ctx.modelCatalog.providerModels('acme', second.version))['acme/model']?.name).toBe('Changed')
    expect(await env.KV.get(`models-dev:${second.version}:manifest`, 'json')).toMatchObject({
      version: second.version, schemaVersion: 1, hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      shards: expect.arrayContaining([`models-dev:${second.version}:models`, `models-dev:${second.version}:providers`, `models-dev:${second.version}:provider:acme`]),
    })
  })

  it('does not create or rewrite generation keys when the original byte hash is unchanged', async () => {
    const ctx = await createApp({ env, side: 'worker' })
    serve()
    const first = await ctx.modelCatalog.refresh('manual')
    const before = await env.KV.list({ prefix: `models-dev:${first.version}:` })
    const contents = await Promise.all(before.keys.map(key => env.KV.getWithMetadata(key.name)))
    const again = await ctx.modelCatalog.refresh('manual')
    expect(again).toEqual({ ...first, changed: false })
    expect((await env.KV.list({ prefix: 'models-dev:' })).keys.filter(key => key.name.endsWith(':manifest'))).toHaveLength(1)
    expect(await Promise.all(before.keys.map(key => env.KV.getWithMetadata(key.name)))).toEqual(contents)
  })

  it('leaves an unaffected stored model unwritten when unrelated catalog metadata changes', async () => {
    const { ctx, model } = await seedLeasedModel()
    serve()
    await ctx.modelCatalog.refresh('manual')
    await env.DB.exec('CREATE TABLE catalog_model_write_audit (model_id INTEGER)')
    await env.DB.exec('CREATE TRIGGER catalog_model_write_audit_update AFTER UPDATE ON models BEGIN INSERT INTO catalog_model_write_audit VALUES (new.id); END')
    const next = catalog()
    next.providers.acme.models['not-installed'].name = 'Unrelated catalog change'
    serve(next)
    try {
      expect(await ctx.modelCatalog.refresh('manual')).toMatchObject({ changed: true })
      expect((await env.DB.prepare('SELECT model_id FROM catalog_model_write_audit WHERE model_id = ?').bind(model.id).all()).results).toEqual([])
      expect((await ctx.db.orm.select().from(models).where(eq(models.id, model.id)))[0]?.metadata_resolved.name).toBe('Catalog model')
    } finally {
      await env.DB.exec('DROP TRIGGER catalog_model_write_audit_update')
      await env.DB.exec('DROP TABLE catalog_model_write_audit')
    }
  })

  it('materializes only stored models, respecting overrides and enabled state', async () => {
    const ctx = await createApp({ env, side: 'worker' })
    const [provider] = await ctx.db.orm.insert(providers).values({ user_id: 1, name: 'catalog-test', created_at: 0 }).returning()
    const [endpoint] = await ctx.db.orm.insert(providerInterfaces).values({ provider_id: provider!.id, protocol: 'responses', base_url: 'https://acme.test/v1', created_at: 0 }).returning()
    await ctx.db.orm.update(providers).set({ default_interface_id: endpoint!.id }).where(eq(providers.id, provider!.id))
    await ctx.db.orm.insert(models).values({ provider_id: provider!.id, model_id: 'acme/model', metadata_override: { name: 'My name', reasoning: false }, enabled: false })
    serve()
    await ctx.modelCatalog.refresh('manual')
    const rows = await ctx.db.orm.select().from(models).where(eq(models.provider_id, provider!.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ enabled: false, metadata_override: { name: 'My name', reasoning: false }, metadata_resolved: { name: 'My name', reasoning: false, tool_call: true }, supports_image_input: true, supports_reasoning: false, supports_tools: true, context_limit: 1000, output_limit: 100, lab_id: 'acme', search_name: 'my name acme/model acme', catalog_matches: { operator: { provider_id: 'acme', model_id: 'acme/model', kind: 'exact' } } })
    expect((await ctx.db.orm.select().from(providers).where(eq(providers.id, provider!.id)))[0]).toMatchObject({ models_dev_provider_id: 'acme', models_dev_provider_source: 'endpoint' })
  })

  it('retains upstream provider metadata when rematerializing a model the catalog does not know', async () => {
    const ctx = await createApp({ env, side: 'worker' })
    const [provider] = await ctx.db.orm.insert(providers).values({ user_id: 1, name: 'provider-metadata', created_at: 0 }).returning()
    await ctx.db.orm.insert(models).values({
      provider_id: provider!.id, model_id: 'vendor/image-only', enabled: true,
      provider_metadata: { id: 'vendor/image-only', input_modalities: ['text', 'image'], output_modalities: ['image'] },
    })
    serve()
    await ctx.modelCatalog.refresh('manual')
    const [row] = await ctx.db.orm.select().from(models).where(eq(models.provider_id, provider!.id))
    expect(row).toMatchObject({ supports_image_input: true, supports_image_output: true })
    expect(row?.metadata_resolved.modalities).toEqual({ input: ['text', 'image'], output: ['image'] })
  })

  it.each([['HTTP', {}, 503], ['schema', { providers: {} }, 200], ['model validation', { providers: {}, models: { broken: { id: 'broken', reasoning: 'yes' } } }, 200]])('preserves active and reports a %s failure', async (_label, body, status) => {
    const ctx = await createApp({ env, side: 'worker' })
    serve()
    const first = await ctx.modelCatalog.refresh('manual')
    const previousStatus = await ctx.modelCatalog.status()
    serve(body, status as number)
    await expect(ctx.modelCatalog.refresh('manual')).rejects.toThrow()
    expect(await publication()).toEqual({ current: first.version, previous: null })
    expect(await ctx.modelCatalog.status()).toMatchObject({ version: first.version, lastSuccessAt: previousStatus.lastSuccessAt, lastError: expect.any(String) })
  })

  it('does not activate or partially materialize when D1 fails', async () => {
    const ctx = await createApp({ env, side: 'worker' })
    serve()
    const first = await ctx.modelCatalog.refresh('manual')
    const [provider] = await ctx.db.orm.insert(providers).values({ user_id: 1, name: 'fail', created_at: 0 }).returning()
    await ctx.db.orm.insert(models).values({ provider_id: provider!.id, model_id: 'acme/model' })
    await env.DB.exec("CREATE TRIGGER fail_catalog_materialize BEFORE UPDATE OF metadata_resolved ON models BEGIN SELECT RAISE(ABORT, 'materialization failed'); END")
    serve(catalog('Changed'))
    try {
      await expect(ctx.modelCatalog.refresh('manual')).rejects.toThrow()
    } finally {
      await env.DB.exec('DROP TRIGGER fail_catalog_materialize')
    }
    expect(await publication()).toEqual({ current: first.version, previous: null })
    expect((await ctx.db.orm.select().from(models).where(eq(models.provider_id, provider!.id)))[0]?.metadata_resolved).toEqual({})
  })

  it('keeps the active generation when a staging KV write fails', async () => {
    const ctx = await createApp({ env, side: 'worker' })
    serve()
    const first = await ctx.modelCatalog.refresh('manual')
    const failingKV = new Proxy(env.KV, {
      get(target, property) {
        if (property === 'put') return async (key: string, value: string, options?: KVNamespacePutOptions) => {
          if (key.endsWith(':provider:acme')) throw new Error('KV unavailable')
          return target.put(key, value, options)
        }
        const member = Reflect.get(target, property)
        return typeof member === 'function' ? member.bind(target) : member
      },
    })
    const failing = await createApp({ env: { ...env, KV: failingKV }, side: 'worker' })
    serve(catalog('Changed'))
    await expect(failing.modelCatalog.refresh('manual')).rejects.toThrow('storage')
    expect(await publication()).toEqual({ current: first.version, previous: null })
    expect((await ctx.modelCatalog.providerModels('acme', first.version))['acme/model']?.name).toBe('Catalog model')
  })

  it('publishes and reads the catalog using only immutable KV records', async () => {
    const ctx = await createApp({ env, side: 'worker' })
    serve()
    const first = await ctx.modelCatalog.refresh('manual')
    const immutableKV = new Proxy(env.KV, {
      get(target, property) {
        if (property === 'put') return async (key: string, value: string, options?: KVNamespacePutOptions) => {
          if (!/^models-dev:[^:]+:/u.test(key)) throw new Error('Unversioned KV write')
          return target.put(key, value, options)
        }
        if (property === 'get') return async (key: string, type: 'json') => {
          if (!/^models-dev:[^:]+:/u.test(key)) throw new Error('Unversioned KV read')
          return target.get(key, type)
        }
        const member = Reflect.get(target, property)
        return typeof member === 'function' ? member.bind(target) : member
      },
    })
    const isolated = await createApp({ env: { ...env, KV: immutableKV }, side: 'worker' })
    serve(catalog('Committed'))
    const committed = await isolated.modelCatalog.refresh('manual')
    expect(await publication()).toEqual({ current: committed.version, previous: first.version })
    expect(await isolated.modelCatalog.status()).toMatchObject({ version: committed.version, previousVersion: first.version, lastError: null })
    expect((await isolated.modelCatalog.providerIndex()).acme?.name).toBe('Acme')
    expect((await isolated.modelCatalog.providerModels('acme', committed.version))['acme/model']?.name).toBe('Committed')
    expect((await isolated.modelCatalog.globalModels(committed.version))['acme/model']?.name).toBe('Global model')
  })

  it('falls back to previous when current shards are missing, and returns empty before first refresh', async () => {
    const ctx = await createApp({ env, side: 'worker' })
    expect(await ctx.modelCatalog.providerIndex()).toEqual({})
    expect(await ctx.modelCatalog.status()).toMatchObject({ version: null, lastSuccessAt: null, lastError: null })
    serve()
    const first = await ctx.modelCatalog.refresh('manual')
    serve(catalog('Changed'))
    const second = await ctx.modelCatalog.refresh('manual')
    for (const shard of ['providers', 'models', 'provider:acme']) await env.KV.delete(`models-dev:${second.version}:${shard}`)
    expect((await ctx.modelCatalog.providerIndex()).acme?.name).toBe('Acme')
    expect((await ctx.modelCatalog.globalModels(second.version))['acme/model']?.name).toBe('Global model')
    expect((await ctx.modelCatalog.providerModels('acme', second.version))['acme/model']?.name).toBe('Catalog model')
    expect((await ctx.modelCatalog.providerModels('acme', first.version))['acme/model']?.name).toBe('Catalog model')
  })

  it('does not revive a provider intentionally absent from the current catalog', async () => {
    const ctx = await createApp({ env, side: 'worker' })
    serve()
    await ctx.modelCatalog.refresh('manual')
    serve({ providers: {}, models: {} })
    const second = await ctx.modelCatalog.refresh('manual')
    expect(await ctx.modelCatalog.providerModels('acme', second.version)).toEqual({})
  })

  it('cron collects stale staging shards even on fetch failure while preserving active, previous and younger shards', async () => {
    const ctx = await createApp({ env, side: 'worker' })
    serve()
    const first = await ctx.modelCatalog.refresh('manual')
    serve(catalog('Changed'))
    const second = await ctx.modelCatalog.refresh('manual')
    const now = Date.now()
    const old = now - 48 * 60 * 60 * 1000 - 1
    await env.KV.put('models-dev:abandoned:models', '{}', { metadata: { fetchedAt: old } })
    await env.KV.put('models-dev:recent:models', '{}', { metadata: { fetchedAt: now } })
    for (const version of [first.version, second.version]) {
      const key = `models-dev:${version}:models`
      await env.KV.put(key, (await env.KV.get(key))!, { metadata: { fetchedAt: old } })
    }
    serve({}, 503)
    await expect(ctx.modelCatalog.refresh('cron')).rejects.toThrow()
    expect(await env.KV.get('models-dev:abandoned:models')).toBeNull()
    expect(await env.KV.get('models-dev:recent:models')).toBe('{}')
    expect(await env.KV.get(`models-dev:${first.version}:models`)).not.toBeNull()
    expect(await env.KV.get(`models-dev:${second.version}:models`)).not.toBeNull()
  })

  it('exposes status, searchable provider index and refresh counts through the Worker routes', async () => {
    const createdDispose = vi.fn()
    const instanceDispose = vi.fn()
    const statusResultDispose = vi.fn()
    const create = vi.fn().mockResolvedValue({ id: 'catalog-manual-refresh-test-id', [Symbol.dispose]: createdDispose })
    const workflow = {
      create,
      get: vi.fn().mockResolvedValue({
        status: vi.fn().mockResolvedValue({ status: 'running', [Symbol.dispose]: statusResultDispose }),
        [Symbol.dispose]: instanceDispose,
      }),
    }
    const ctx = await createApp({ env: { ...env, MODEL_CATALOG_REFRESH: workflow as unknown as Workflow }, side: 'worker' })
    const initial = await authenticatedRequest(ctx.api, '/api/model-catalog/status')
    expect(initial.status).toBe(200)
    expect(await initial.json()).toMatchObject({ version: null })
    const refresh = await authenticatedRequest(ctx.api, '/api/model-catalog/refresh', { method: 'POST' })
    expect(refresh.status).toBe(202)
    expect(await refresh.json()).toEqual({ instanceId: 'catalog-manual-refresh-test-id' })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ params: { source: 'manual' } }))
    expect(createdDispose).toHaveBeenCalledOnce()
    const running = await authenticatedRequest(ctx.api, '/api/model-catalog/refresh/catalog-manual-refresh-test-id')
    expect(await running.json()).toEqual({ status: 'running' })
    expect(statusResultDispose).toHaveBeenCalledOnce()
    expect(instanceDispose).toHaveBeenCalledOnce()
    serve()
    await ctx.modelCatalog.refresh('manual')
    const found = await authenticatedRequest(ctx.api, '/api/model-catalog/providers?q=ACM')
    expect(await found.json()).toEqual([{ id: 'acme', name: 'Acme', api: 'https://acme.test/v1' }])
    expect(await (await authenticatedRequest(ctx.api, '/api/model-catalog/providers?q=missing')).json()).toEqual([])
  })
})
