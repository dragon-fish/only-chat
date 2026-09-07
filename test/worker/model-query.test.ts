import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelPageSchema, ModelWithMetadataSchema, type ModelPage } from '@/shared/models'
import { catalogApp, catalogFixture } from './provider-catalog-fixture'
import { buildModelQuery } from '@/server/plugins/api/model-query'
import { catalogForModels, resolveModelFields } from '@/server/plugins/api/model-write'

afterEach(() => vi.unstubAllGlobals())

describe('catalog-backed model membership and queries', () => {
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

  it('keeps representative filtered page reads bounded as the model table grows', async () => {
    const { createProvider } = await catalogApp()
    const provider = await createProvider()
    await env.DB.prepare(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM ids WHERE n < 2000)
      INSERT INTO models (provider_id, model_id, display_name, capabilities, enabled, supports_image_input, search_name)
      SELECT ?, 'scale-' || n, 'Scale ' || n, '{}', 1, n % 2, 'scale model ' || n FROM ids`).bind(provider.id).run()
    const query = buildModelQuery({ provider_id: provider.id, enabled: true, vision: true, limit: 50 })
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.params).all<{ detail: string }>()
    expect(plan.results.some(row => /USING (?:COVERING )?INDEX/u.test(row.detail))).toBe(true)
    expect(plan.results.some(row => /SCAN (?:m|models)(?: |$)/u.test(row.detail))).toBe(false)
    const page = await env.DB.prepare(query.sql).bind(...query.params).all()
    expect(page.results).toHaveLength(51)
    expect(page.meta.rows_read).toBeLessThan(250)
    console.info('Model query diagnostic', { seeded_models: 2000, returned_rows: page.results.length, rows_read: page.meta.rows_read, plan: plan.results.map(row => row.detail) })
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
