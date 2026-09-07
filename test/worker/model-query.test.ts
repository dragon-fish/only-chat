import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelPageSchema, ModelWithMetadataSchema, type ModelPage } from '@/shared/models'
import { catalogApp, catalogFixture } from './provider-catalog-fixture'
import { buildModelQuery } from '@/server/plugins/api/model-query'
import { catalogForModels, resolveModelFields } from '@/server/plugins/api/model-write'
import { createApp } from '@/server/app'

afterEach(() => vi.unstubAllGlobals())

describe('catalog-backed model membership and queries', () => {
  it.each(['manifest', 'providers', 'models', 'provider:gateway', 'provider:lab'])('rejects materialization when the current %s shard is missing despite a previous generation', async shard => {
    const { ctx, request, createProvider } = await catalogApp()
    const provider = await createProvider()
    const created = ModelWithMetadataSchema.parse(await (await request('POST', `/providers/${provider.id}/models`, { model_id: 'lab/alpha' })).json())
    const previous = (await ctx.modelCatalog.status()).version!
    const next = structuredClone(catalogFixture)
    next.providers.gateway.models['lab/alpha'].name = 'Current operator'
    next.providers.gateway.models['lab/alpha'].limit.context = 300
    vi.stubGlobal('fetch', async () => Response.json(next))
    const current = await ctx.modelCatalog.refresh('manual')
    const before = await env.DB.prepare('SELECT * FROM models WHERE id = ?').bind(created.id).first()
    const key = `models-dev:${current.version}:${shard}`
    const contents = (await env.MODEL_CATALOG.get(key))!
    expect(await env.MODEL_CATALOG.get(`models-dev:${previous}:${shard}`)).not.toBeNull()
    await env.MODEL_CATALOG.delete(key)
    try {
      const response = await request('PUT', `/providers/${provider.id}/models/${created.id}`, { metadata_override: { description: 'Pending edit' } })
      expect(response.status).toBe(503)
      expect(await env.DB.prepare('SELECT * FROM models WHERE id = ?').bind(created.id).first()).toEqual(before)
    } finally {
      await env.MODEL_CATALOG.put(key, contents)
    }
    expect(await ctx.modelCatalog.refresh('manual')).toMatchObject({ version: current.version, changed: false })
    const saved = await request('PUT', `/providers/${provider.id}/models/${created.id}`, { metadata_override: { description: 'Pending edit' } })
    expect(saved.status).toBe(200)
    expect(ModelWithMetadataSchema.parse(await saved.json())).toMatchObject({
      metadata_override: { description: 'Pending edit' },
      metadata: { name: 'Current operator', description: 'Pending edit', limit: { context: 300 } },
    })
  })

  it.each(['generation', 'required shard', 'provider index'] as const)('rejects a manifest-inconsistent %s before persisting model edits', async mismatch => {
    const { ctx, request, createProvider } = await catalogApp()
    const provider = await createProvider()
    const created = ModelWithMetadataSchema.parse(await (await request('POST', `/providers/${provider.id}/models`, { model_id: 'lab/alpha' })).json())
    const version = (await ctx.modelCatalog.status()).version!
    const key = `models-dev:${version}:manifest`
    const contents = (await env.MODEL_CATALOG.get(key))!
    const manifest = JSON.parse(contents)
    if (mismatch === 'generation') manifest.version = 'different-generation'
    if (mismatch === 'required shard') manifest.shards = manifest.shards.filter((shard: string) => !shard.endsWith(':provider:gateway'))
    if (mismatch === 'provider index') manifest.providers += 1
    await env.MODEL_CATALOG.put(key, JSON.stringify(manifest))
    try {
      const response = await request('PUT', `/providers/${provider.id}/models/${created.id}`, { metadata_override: { name: 'Must not persist' } })
      expect(response.status).toBe(503)
      expect(await env.DB.prepare('SELECT metadata_override FROM models WHERE id = ?').bind(created.id).first()).toEqual({ metadata_override: '{}' })
    } finally { await env.MODEL_CATALOG.put(key, contents) }
  })

  it.each(['create', 'import', 'reassociate'] as const)('leaves provider and model state intact when %s cannot read a required current Lab shard', async operation => {
    const { ctx, request, createProvider } = await catalogApp()
    const provider = await createProvider()
    expect((await request('POST', `/providers/${provider.id}/models`, { model_id: 'lab/alpha' })).status).toBe(201)
    const next = structuredClone(catalogFixture)
    next.providers.gateway.models['lab/alpha'].name = 'Current operator'
    vi.stubGlobal('fetch', async () => Response.json(next))
    const current = await ctx.modelCatalog.refresh('manual')
    const beforeModels = (await env.DB.prepare('SELECT * FROM models WHERE provider_id = ?').bind(provider.id).all()).results
    const beforeProvider = await env.DB.prepare('SELECT * FROM providers WHERE id = ?').bind(provider.id).first()
    await env.MODEL_CATALOG.delete(`models-dev:${current.version}:provider:lab`)
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'lab/new' }] }))
    const response = operation === 'create'
      ? await request('POST', `/providers/${provider.id}/models`, { model_id: 'lab/new' })
      : operation === 'import'
        ? await request('POST', `/providers/${provider.id}/fetch-models`)
        : await request('PUT', `/providers/${provider.id}`, { name: 'Must not persist', default_protocol: 'responses', interfaces: [{ protocol: 'responses', base_url: 'https://unknown.test/v1' }] })
    expect(response.status).toBe(503)
    expect((await env.DB.prepare('SELECT * FROM models WHERE provider_id = ?').bind(provider.id).all()).results).toEqual(beforeModels)
    expect(await env.DB.prepare('SELECT * FROM providers WHERE id = ?').bind(provider.id).first()).toEqual(beforeProvider)
  })

  it.each(['POST', 'PUT'])('rejects incomplete replacement tiers before a %s can mutate a model', async method => {
    const { request, createProvider } = await catalogApp()
    const provider = await createProvider()
    const created = ModelWithMetadataSchema.parse(await (await request('POST', `/providers/${provider.id}/models`, { model_id: 'lab/alpha' })).json())
    const path = `/providers/${provider.id}/models${method === 'PUT' ? `/${created.id}` : ''}`
    const response = await request(method, path, { model_id: 'invalid-tier', metadata_override: { cost: { tiers: [{ input: 0 }] } } })
    expect(response.status).toBe(400)
    const rows = await env.DB.prepare('SELECT model_id, metadata_override FROM models WHERE provider_id = ?').bind(provider.id).all()
    expect(rows.results).toEqual([{ model_id: 'lab/alpha', metadata_override: '{}' }])
    const cost = { tiers: [{ tier: { size: 0 }, input: 0, output: 0 }] }
    const accepted = await request(method, path, { model_id: 'complete-tier', metadata_override: { cost } })
    expect(accepted.status).toBe(method === 'PUT' ? 200 : 201)
    expect(ModelWithMetadataSchema.parse(await accepted.json())).toMatchObject({ metadata_override: { cost }, metadata: { cost } })
  })

  it('accepts unchanged override snapshots with legacy JSON number formatting', async () => {
    const { request, createProvider } = await catalogApp()
    const provider = await createProvider()
    const created = ModelWithMetadataSchema.parse(await (await request('POST', `/providers/${provider.id}/models`, { model_id: 'legacy-json' })).json())
    await env.DB.prepare('UPDATE models SET metadata_override = ? WHERE id = ?').bind('{ "name": "Legacy", "cost": { "input": 3.0 } }', created.id).run()
    const response = await request('PUT', `/providers/${provider.id}/models/${created.id}`, { enabled: false })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ metadata: { name: 'Legacy', cost: { input: 3 } }, metadata_override: { name: 'Legacy', cost: { input: 3 } }, enabled: false })
  })

  it('bounds retries and rolls back reassociation while model sources keep changing', async () => {
    const { request, createProvider } = await catalogApp()
    const provider = await createProvider()
    const created = ModelWithMetadataSchema.parse(await (await request('POST', `/providers/${provider.id}/models`, { model_id: 'lab/alpha' })).json())
    let attempts = 0
    const contestedDB = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
          if (++attempts > 3) throw new Error('Retry did not stop')
          expect((await request('PUT', `/providers/${provider.id}/models/${created.id}`, { metadata_override: { name: `Concurrent edit ${attempts}` } })).status).toBe(200)
          return target.batch(statements)
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const contested = await createApp({ env: { ...env, DB: contestedDB }, side: 'worker' })
    const response = await contested.api.request(`/api/providers/${provider.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      name: 'Must roll back', default_protocol: 'responses', interfaces: [{ protocol: 'responses', base_url: 'https://unknown.test/v1' }],
    }) })
    expect(response.status).toBe(409)
    expect(attempts).toBe(3)
    expect(await env.DB.prepare('SELECT name, models_dev_provider_id FROM providers WHERE id = ?').bind(provider.id).first()).toEqual({ name: 'Gateway', models_dev_provider_id: 'gateway' })
    const current = ModelWithMetadataSchema.parse(await (await request('GET', `/providers/${provider.id}/models/by-ref?model_id=lab%2Falpha`)).json())
    expect(current.metadata.name).toBe('Concurrent edit 3')
    expect(current.metadata_override.name).toBe('Concurrent edit 3')
  })

  it('recomputes a catalog refresh after a concurrent model override edit', async () => {
    const { request, createProvider } = await catalogApp()
    const provider = await createProvider()
    const created = ModelWithMetadataSchema.parse(await (await request('POST', `/providers/${provider.id}/models`, { model_id: 'lab/alpha', metadata_override: { name: 'Old override' } })).json())
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
    const nextCatalog = structuredClone(catalogFixture)
    nextCatalog.providers.gateway.models['lab/alpha'].limit.context = 300
    vi.stubGlobal('fetch', async () => Response.json(nextCatalog))
    const pending = delayed.modelCatalog.refresh('manual')
    await arrived
    try {
      expect((await request('PUT', `/providers/${provider.id}/models/${created.id}`, { metadata_override: { name: 'Current override', tool_call: true } })).status).toBe(200)
    } finally { release() }
    await pending
    const current = ModelWithMetadataSchema.parse(await (await request('GET', `/providers/${provider.id}/models/by-ref?model_id=lab%2Falpha`)).json())
    expect(current.metadata_override).toEqual({ name: 'Current override', tool_call: true })
    expect(current.metadata).toMatchObject({ name: 'Current override', tool_call: true, limit: { context: 300 } })
  })

  it.each(['override', 'association'] as const)('retries a model rename when its %s source changes during resolution', async source => {
    const { request, createProvider } = await catalogApp()
    const provider = await createProvider()
    const created = ModelWithMetadataSchema.parse(await (await request('POST', `/providers/${provider.id}/models`, { model_id: 'draft', metadata_override: { name: 'Original override' } })).json())
    const delayed = await createApp({ env, side: 'worker' })
    let arrive!: () => void
    let release!: () => void
    const arrived = new Promise<void>(resolve => { arrive = resolve })
    const resume = new Promise<void>(resolve => { release = resolve })
    const readCatalog = delayed.modelCatalog.materializationCatalog.bind(delayed.modelCatalog)
    vi.spyOn(delayed.modelCatalog, 'materializationCatalog').mockImplementationOnce(async (...args) => { arrive(); await resume; return readCatalog(...args) })
    const pending = delayed.api.request(`/api/providers/${provider.id}/models/${created.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model_id: 'lab/alpha' }) })
    await arrived
    try {
      const edit = source === 'override'
        ? await request('PUT', `/providers/${provider.id}/models/${created.id}`, { metadata_override: { name: 'Current override' } })
        : await request('PUT', `/providers/${provider.id}`, { name: provider.name, default_protocol: 'responses', interfaces: [{ protocol: 'responses', base_url: 'https://unknown.test/v1' }] })
      expect(edit.status).toBe(200)
    } finally { release() }
    expect((await pending).status).toBe(200)
    const current = ModelWithMetadataSchema.parse(await (await request('GET', `/providers/${provider.id}/models/by-ref?model_id=lab%2Falpha`)).json())
    expect(current.metadata.name).toBe(current.metadata_override.name)
    expect(current.metadata).toMatchObject({ name: source === 'override' ? 'Current override' : 'Original override', limit: { context: source === 'association' ? 200 : 100 } })
  })

  it.each(['reassociate', 'import'] as const)('recomputes %s metadata after a concurrent model override edit', async operation => {
    const { request, createProvider } = await catalogApp()
    const provider = await createProvider()
    const created = ModelWithMetadataSchema.parse(await (await request('POST', `/providers/${provider.id}/models`, {
      model_id: 'lab/alpha', metadata_override: { name: 'Old override', tool_call: false },
    })).json())
    if (operation === 'import') {
      await env.DB.prepare("UPDATE models SET metadata_resolved = '{}', search_name = '' WHERE id = ?").bind(created.id).run()
      vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'lab/alpha' }] }))
    }
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
    const pending = operation === 'import'
      ? delayed.api.request(`/api/providers/${provider.id}/fetch-models`, { method: 'POST' })
      : delayed.api.request(`/api/providers/${provider.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        name: provider.name, default_protocol: 'responses', interfaces: [{ protocol: 'responses', base_url: 'https://unknown.test/v1' }],
      }) })
    await arrived
    try {
      expect((await request('PUT', `/providers/${provider.id}/models/${created.id}`, { metadata_override: { name: 'Current override', tool_call: true } })).status).toBe(200)
    } finally { release() }
    expect((await pending).status).toBe(200)
    const current = ModelWithMetadataSchema.parse(await (await request('GET', `/providers/${provider.id}/models/by-ref?model_id=lab%2Falpha`)).json())
    expect(current.metadata_override).toEqual({ name: 'Current override', tool_call: true })
    expect(current.metadata).toMatchObject({ name: 'Current override', tool_call: true, limit: { context: operation === 'reassociate' ? 200 : 100 } })
    expect(await env.DB.prepare('SELECT search_name, supports_tools FROM models WHERE id = ?').bind(created.id).first()).toMatchObject({ search_name: 'current override lab/alpha research lab', supports_tools: 1 })
  })

  it('pins the provider index and model shards to the same catalog generation during refresh', async () => {
    const { ctx } = await catalogApp()
    const previous = await ctx.modelCatalog.status()
    vi.spyOn(ctx.modelCatalog, 'status').mockImplementationOnce(async () => {
      vi.stubGlobal('fetch', async () => Response.json({ providers: { lab: catalogFixture.providers.lab }, models: catalogFixture.models }))
      await ctx.modelCatalog.refresh('manual')
      return previous
    })
    const catalog = await catalogForModels(ctx, 'gateway', ['lab/alpha'])
    expect(resolveModelFields(catalog, 'gateway', 'lab/alpha', {}).metadata_resolved.name).toBe('Operator alpha')
  })

  it.each([
    { interval: 2, limit: 50 },
    { interval: 20, limit: 20 },
  ])('keeps provider-filtered reads bounded for one match every $interval models, including a later cursor page', async ({ interval, limit }) => {
    const { createProvider } = await catalogApp()
    const provider = await createProvider()
    await env.DB.prepare(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM ids WHERE n < 2000)
      INSERT INTO models (provider_id, model_id, display_name, capabilities, enabled, supports_image_input, search_name)
      SELECT ?, 'scale-' || n, 'Scale ' || n, '{}', 1, n % ? = 0, 'scale model ' || n FROM ids`).bind(provider.id, interval).run()
    let cursor: string | undefined
    for (const pageNumber of [1, 2]) {
      const query = buildModelQuery({ provider_id: provider.id, enabled: true, vision: true, limit, cursor })
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.params).all<{ detail: string }>()
      expect(plan.results.some(row => /USING (?:COVERING )?INDEX/u.test(row.detail))).toBe(true)
      expect(plan.results.some(row => /SCAN (?:m|models)(?: |$)/u.test(row.detail))).toBe(false)
      const page = await env.DB.prepare(query.sql).bind(...query.params).all<{ id: number; sort: number; model_id: string }>()
      expect(page.results).toHaveLength(limit + 1)
      expect(page.results[0]!.model_id).toBe(`scale-${((pageNumber - 1) * limit + 1) * interval}`)
      expect(page.meta.rows_read).toBeLessThan(250)
      const last = page.results[limit - 1]!
      cursor = btoa(JSON.stringify({ sort: last.sort, id: last.id }))
      console.info('Model query diagnostic', { seeded_models: 2000, match_interval: interval, page: pageNumber, returned_rows: page.results.length, rows_read: page.meta.rows_read, plan: plan.results.map(row => row.detail) })
    }
  })

  it('imports only remote IDs, preserves manual models and overrides, and resolves operator metadata', async () => {
    const { request, createProvider } = await catalogApp()
    const provider = await createProvider()
    const manual = await request('POST', `/providers/${provider.id}/models`, {
      model_id: 'manual', metadata_override: { name: 'My manual model', tool_call: false }, enabled: false, sort: 8,
    })
    expect(manual.status).toBe(201)
    vi.stubGlobal('fetch', async (url: string) => {
      expect(url).toBe('https://gateway.test/v1/models')
      return Response.json({ data: [{ id: 'lab/alpha' }, { id: 'manual' }, { id: 'lab/alpha' }] })
    })
    const imported = await request('POST', `/providers/${provider.id}/fetch-models`)
    expect(await imported.json()).toMatchObject({ imported: 1 })
    const list = ModelPageSchema.parse(await (await request('GET', `/providers/${provider.id}/models`)).json())
    expect(list.models.map(model => model.model_id)).toEqual(['lab/alpha', 'manual'])
    expect(list.models[0]).toMatchObject({ metadata: { name: 'Operator alpha', tool_call: false, limit: { context: 100 }, cost: { input: 3 } }, lab_id: 'lab', interface_id: null })
    expect(list.models[1]).toMatchObject({ metadata: { name: 'My manual model', tool_call: false }, enabled: false, sort: 8 })
    await env.DB.exec('CREATE TABLE model_query_audit (model_id TEXT)')
    await env.DB.exec('CREATE TRIGGER model_query_audit_update AFTER UPDATE ON models BEGIN INSERT INTO model_query_audit VALUES (new.model_id); END')
    await request('POST', `/providers/${provider.id}/fetch-models`)
    const audit = await env.DB.prepare('SELECT model_id FROM model_query_audit').all()
    await env.DB.exec('DROP TRIGGER model_query_audit_update')
    await env.DB.exec('DROP TABLE model_query_audit')
    expect(audit.results).toEqual([])
  })

  it('uses only safe lab metadata on unmatched operators and removes overrides on reset', async () => {
    const { request, createProvider } = await catalogApp()
    const provider = await createProvider({ interfaces: [{ protocol: 'responses', base_url: 'https://unknown.test/v1' }] })
    const created = ModelWithMetadataSchema.parse(await (await request('POST', `/providers/${provider.id}/models`, {
      model_id: 'lab/alpha', metadata_override: { name: 'Custom alpha', limit: { output: 5 }, cost: null },
    })).json())
    expect(created).toMatchObject({ metadata: { name: 'Custom alpha', limit: { context: 200, output: 5 }, cost: null, modalities: { input: ['text', 'image'] }, reasoning_options: [{ type: 'toggle' }] } })
    expect(created.metadata.tool_call).toBeUndefined()
    const reset = ModelWithMetadataSchema.parse(await (await request('PUT', `/providers/${provider.id}/models/${created.id}`, { metadata_override: {} })).json())
    expect(reset.metadata).toMatchObject({ name: 'Global alpha', cost: { input: 2 }, limit: { context: 200 } })
    expect(reset.metadata.limit?.output).toBeUndefined()
    expect(reset.metadata_override).toEqual({})
  })

  it('rejects cross-provider interfaces and duplicate membership without overwriting rows', async () => {
    const { request, createProvider } = await catalogApp()
    const first = await createProvider()
    const second = await createProvider()
    expect((await request('POST', `/providers/${first.id}/models`, { model_id: 'bad', interface_id: second.interfaces[0]!.id })).status).toBe(400)
    const own = ModelWithMetadataSchema.parse(await (await request('POST', `/providers/${first.id}/models`, { model_id: 'own', enabled: false })).json())
    expect((await request('PUT', `/providers/${first.id}/models/${own.id}`, { interface_id: second.interfaces[0]!.id })).status).toBe(400)
    expect((await request('POST', `/providers/${first.id}/models`, { model_id: 'own', enabled: true })).status).toBe(409)
    expect(ModelWithMetadataSchema.parse(await (await request('GET', `/providers/${first.id}/models/by-ref?model_id=own`)).json()).enabled).toBe(false)
  })

  it('filters materialized fields and inherited interfaces, and paginates equal sorts without duplicates', async () => {
    const { request, createProvider } = await catalogApp()
    const provider = await createProvider({ interfaces: [
      { protocol: 'responses', base_url: 'https://unknown.test/v1' },
      { protocol: 'anthropic', base_url: 'https://unknown.test/messages' },
    ] })
    for (const [model_id, enabled, sort] of [['lab/alpha', true, 0], ['beta', true, 0], ['gamma', true, 1], ['hidden', false, 1]] as const) {
      expect((await request('POST', `/providers/${provider.id}/models`, { model_id, enabled, sort })).status).toBe(201)
    }
    const first = ModelPageSchema.parse(await (await request('GET', `/models?provider_id=${provider.id}&enabled=true&limit=2`)).json())
    expect(first.models.map(model => model.model_id)).toEqual(['lab/alpha', 'beta'])
    expect(first.next_cursor).not.toBeNull()
    const second = ModelPageSchema.parse(await (await request('GET', `/models?provider_id=${provider.id}&enabled=true&limit=2&cursor=${encodeURIComponent(first.next_cursor!)}`)).json())
    expect(second.models.map(model => model.model_id)).toEqual(['gamma'])
    expect(second.next_cursor).toBeNull()
    const filtered = ModelPageSchema.parse(await (await request('GET', `/models?provider_id=${provider.id}&vision=true&reasoning=true&min_context=150&lab_id=lab&interface_id=${provider.default_interface_id}&search=alpha`)).json())
    expect(filtered.models.map(model => model.model_id)).toEqual(['lab/alpha'])
    const otherInterface = provider.interfaces.find(item => item.protocol === 'anthropic')!
    expect((await (await request('GET', `/models?provider_id=${provider.id}&interface_id=${otherInterface.id}`)).json() as ModelPage).models).toEqual([])
    expect((await request('GET', '/models?search=ab')).status).toBe(400)
    expect((await request('GET', '/models?cursor=invalid')).status).toBe(400)
    expect((await request('GET', '/models?enabled=anything')).status).toBe(400)
  })
})
