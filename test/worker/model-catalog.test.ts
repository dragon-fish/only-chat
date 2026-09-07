import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/server/app'
import { models, providerInterfaces, providers } from '@/server/db/schema'

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

async function clearCatalog() {
  const listed = await env.MODEL_CATALOG.list()
  await Promise.all(listed.keys.map(key => env.MODEL_CATALOG.delete(key.name)))
}

beforeEach(clearCatalog)
afterEach(() => vi.unstubAllGlobals())

describe('model catalog', () => {
  it('publishes immutable shards and keeps current plus previous', async () => {
    const ctx = await createApp({ env, side: 'worker' })
    serve()
    const first = await ctx.modelCatalog.refresh('manual')
    expect(first).toMatchObject({ changed: true, providers: 1, globalModels: 1, providerModels: 2 })
    const oldShard = await env.MODEL_CATALOG.get(`models-dev:${first.version}:provider:acme`)
    serve(catalog('Changed'))
    const second = await ctx.modelCatalog.refresh('manual')
    expect(second.version).not.toBe(first.version)
    expect(await env.MODEL_CATALOG.get('models-dev:active', 'json')).toEqual({ current: second.version, previous: first.version })
    expect(await env.MODEL_CATALOG.get(`models-dev:${first.version}:provider:acme`)).toBe(oldShard)
    expect((await ctx.modelCatalog.providerIndex()).acme).toEqual({ id: 'acme', name: 'Acme', api: 'https://acme.test/v1' })
    expect((await ctx.modelCatalog.globalModels(second.version))['acme/model']?.name).toBe('Global model')
    expect((await ctx.modelCatalog.providerModels('acme', second.version))['acme/model']?.name).toBe('Changed')
    expect(await env.MODEL_CATALOG.get(`models-dev:${second.version}:manifest`, 'json')).toMatchObject({
      version: second.version, schemaVersion: 1, hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      shards: expect.arrayContaining([`models-dev:${second.version}:models`, `models-dev:${second.version}:providers`, `models-dev:${second.version}:provider:acme`]),
    })
  })

  it('does not create or rewrite generation keys when the original byte hash is unchanged', async () => {
    const ctx = await createApp({ env, side: 'worker' })
    serve()
    const first = await ctx.modelCatalog.refresh('manual')
    const before = await env.MODEL_CATALOG.list({ prefix: `models-dev:${first.version}:` })
    const contents = await Promise.all(before.keys.map(key => env.MODEL_CATALOG.getWithMetadata(key.name)))
    const again = await ctx.modelCatalog.refresh('manual')
    expect(again).toEqual({ ...first, changed: false })
    expect((await env.MODEL_CATALOG.list({ prefix: 'models-dev:' })).keys.filter(key => key.name.endsWith(':manifest'))).toHaveLength(1)
    expect(await Promise.all(before.keys.map(key => env.MODEL_CATALOG.getWithMetadata(key.name)))).toEqual(contents)
  })

  it('materializes only stored models, respecting overrides and enabled state', async () => {
    const ctx = await createApp({ env, side: 'worker' })
    const [provider] = await ctx.db.orm.insert(providers).values({ user_id: 1, name: 'catalog-test', protocol: 'openai-responses', base_url: 'https://acme.test/v1', created_at: 0 }).returning()
    const [endpoint] = await ctx.db.orm.insert(providerInterfaces).values({ provider_id: provider!.id, protocol: 'responses', base_url: 'https://acme.test/v1', created_at: 0 }).returning()
    await ctx.db.orm.update(providers).set({ default_interface_id: endpoint!.id }).where(eq(providers.id, provider!.id))
    await ctx.db.orm.insert(models).values({ provider_id: provider!.id, model_id: 'acme/model', display_name: 'legacy', capabilities: {}, metadata_override: { name: 'My name', reasoning: false }, enabled: false })
    serve()
    await ctx.modelCatalog.refresh('manual')
    const rows = await ctx.db.orm.select().from(models).where(eq(models.provider_id, provider!.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ enabled: false, metadata_override: { name: 'My name', reasoning: false }, metadata_resolved: { name: 'My name', reasoning: false, tool_call: true }, supports_image_input: true, supports_reasoning: false, supports_tools: true, context_limit: 1000, output_limit: 100, lab_id: 'acme', search_name: 'my name acme/model acme', catalog_matches: { operator: { provider_id: 'acme', model_id: 'acme/model', kind: 'exact' } } })
    expect((await ctx.db.orm.select().from(providers).where(eq(providers.id, provider!.id)))[0]).toMatchObject({ models_dev_provider_id: 'acme', models_dev_provider_source: 'endpoint' })
  })

  it.each([['HTTP', {}, 503], ['schema', { providers: {} }, 200], ['model validation', { providers: {}, models: { broken: { id: 'broken', reasoning: 'yes' } } }, 200]])('preserves active and reports a %s failure', async (_label, body, status) => {
    const ctx = await createApp({ env, side: 'worker' })
    serve()
    const first = await ctx.modelCatalog.refresh('manual')
    const previousStatus = await ctx.modelCatalog.status()
    serve(body, status as number)
    await expect(ctx.modelCatalog.refresh('manual')).rejects.toThrow()
    expect(await env.MODEL_CATALOG.get('models-dev:active', 'json')).toEqual({ current: first.version, previous: null })
    expect(await ctx.modelCatalog.status()).toMatchObject({ version: first.version, lastSuccessAt: previousStatus.lastSuccessAt, lastError: expect.any(String) })
  })

  it('does not activate or partially materialize when D1 fails', async () => {
    const ctx = await createApp({ env, side: 'worker' })
    serve()
    const first = await ctx.modelCatalog.refresh('manual')
    const [provider] = await ctx.db.orm.insert(providers).values({ user_id: 1, name: 'fail', protocol: 'openai-responses', base_url: 'https://acme.test/v1', created_at: 0 }).returning()
    await ctx.db.orm.insert(models).values({ provider_id: provider!.id, model_id: 'acme/model', display_name: 'unchanged', capabilities: {} })
    await env.DB.exec("CREATE TRIGGER fail_catalog_materialize BEFORE UPDATE OF metadata_resolved ON models BEGIN SELECT RAISE(ABORT, 'materialization failed'); END")
    serve(catalog('Changed'))
    try {
      await expect(ctx.modelCatalog.refresh('manual')).rejects.toThrow()
    } finally {
      await env.DB.exec('DROP TRIGGER fail_catalog_materialize')
    }
    expect(await env.MODEL_CATALOG.get('models-dev:active', 'json')).toEqual({ current: first.version, previous: null })
    expect((await ctx.db.orm.select().from(models).where(eq(models.provider_id, provider!.id)))[0]?.metadata_resolved).toEqual({})
  })

  it('keeps the active generation when a staging KV write fails', async () => {
    const ctx = await createApp({ env, side: 'worker' })
    serve()
    const first = await ctx.modelCatalog.refresh('manual')
    const failingKV = new Proxy(env.MODEL_CATALOG, {
      get(target, property) {
        if (property === 'put') return async (key: string, value: string, options?: KVNamespacePutOptions) => {
          if (key.endsWith(':provider:acme')) throw new Error('KV unavailable')
          return target.put(key, value, options)
        }
        const member = Reflect.get(target, property)
        return typeof member === 'function' ? member.bind(target) : member
      },
    })
    const failing = await createApp({ env: { ...env, MODEL_CATALOG: failingKV }, side: 'worker' })
    serve(catalog('Changed'))
    await expect(failing.modelCatalog.refresh('manual')).rejects.toThrow('storage')
    expect(await env.MODEL_CATALOG.get('models-dev:active', 'json')).toEqual({ current: first.version, previous: null })
    expect((await ctx.modelCatalog.providerModels('acme', first.version))['acme/model']?.name).toBe('Catalog model')
  })

  it('falls back to previous when current shards are missing, and returns empty before first refresh', async () => {
    const ctx = await createApp({ env, side: 'worker' })
    expect(await ctx.modelCatalog.providerIndex()).toEqual({})
    expect(await ctx.modelCatalog.status()).toMatchObject({ version: null, lastSuccessAt: null, lastError: null })
    serve()
    const first = await ctx.modelCatalog.refresh('manual')
    serve(catalog('Changed'))
    const second = await ctx.modelCatalog.refresh('manual')
    for (const shard of ['providers', 'models', 'provider:acme']) await env.MODEL_CATALOG.delete(`models-dev:${second.version}:${shard}`)
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
    await env.MODEL_CATALOG.put('models-dev:abandoned:models', '{}', { metadata: { fetchedAt: old } })
    await env.MODEL_CATALOG.put('models-dev:recent:models', '{}', { metadata: { fetchedAt: now } })
    for (const version of [first.version, second.version]) {
      const key = `models-dev:${version}:models`
      await env.MODEL_CATALOG.put(key, (await env.MODEL_CATALOG.get(key))!, { metadata: { fetchedAt: old } })
    }
    serve({}, 503)
    await expect(ctx.modelCatalog.refresh('cron')).rejects.toThrow()
    expect(await env.MODEL_CATALOG.get('models-dev:abandoned:models')).toBeNull()
    expect(await env.MODEL_CATALOG.get('models-dev:recent:models')).toBe('{}')
    expect(await env.MODEL_CATALOG.get(`models-dev:${first.version}:models`)).not.toBeNull()
    expect(await env.MODEL_CATALOG.get(`models-dev:${second.version}:models`)).not.toBeNull()
  })

  it('exposes status, searchable provider index and refresh counts through the Worker routes', async () => {
    const ctx = await createApp({ env, side: 'worker' })
    const initial = await ctx.api.request('/api/model-catalog/status')
    expect(initial.status).toBe(200)
    expect(await initial.json()).toMatchObject({ version: null })
    serve()
    const refresh = await ctx.api.request('/api/model-catalog/refresh', { method: 'POST' })
    expect(refresh.status).toBe(200)
    expect(await refresh.json()).toMatchObject({ changed: true, providers: 1, globalModels: 1, providerModels: 2 })
    const found = await ctx.api.request('/api/model-catalog/providers?q=ACM')
    expect(await found.json()).toEqual([{ id: 'acme', name: 'Acme', api: 'https://acme.test/v1' }])
    expect(await (await ctx.api.request('/api/model-catalog/providers?q=missing')).json()).toEqual([])
  })
})
