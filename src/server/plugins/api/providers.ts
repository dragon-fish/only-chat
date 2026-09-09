import type { Context } from 'cordis'
import { Hono } from 'hono'
import { and, eq, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { authUserId, type ApiEnv } from './auth'
import { ProviderWriteInputSchema } from '@/shared/api'
import { models, providerInterfaces, providers, users } from '../../db/schema'
import { decryptSecret } from '../llm/crypto'
import { listRemoteModels } from '../llm/list-models'
import { cleanupProviderFilesBeforeChange, invalidatedProviderFiles } from '../files-cleanup'
import { elapsed } from '../timings'
import { parseId } from './params'
import { ProviderWriteError, toProviderDto, writeProvider } from './provider-write'
import { catalogForModels, changedModelFields, ModelSourceConflict, modelSourceColumns, modelSourceFence, modelSourceMatches, providerSourceFence, resolveModelFields, retryModelSource } from './model-write'
import { bumpModelListRevisions } from './model-list-cache'

export function providerRoutes(ctx: Context) {
  const r = new Hono<ApiEnv>()
  const db = ctx.db.orm
  const owned = (id: number, userId: number) => and(eq(providers.id, id), eq(providers.user_id, userId))

  r.get('/providers', async c => {
    const userId = authUserId(c)
    const rows = await db.select().from(providers).where(eq(providers.user_id, userId)).orderBy(providers.id)
    const endpoints = await db.select({ interface: providerInterfaces }).from(providerInterfaces)
      .innerJoin(providers, eq(providers.id, providerInterfaces.provider_id)).where(eq(providers.user_id, userId))
      .orderBy(providerInterfaces.id)
    return c.json(rows.map(row => toProviderDto(row, endpoints.filter(endpoint => endpoint.interface.provider_id === row.id).map(endpoint => endpoint.interface))))
  })

  r.on(['POST', 'PUT'], ['/providers', '/providers/:id'], async c => {
    const userId = authUserId(c)
    const id = c.req.param('id') === undefined ? undefined : parseId(c.req.param('id')!)
    if (id === null || (c.req.method === 'PUT' && id === undefined) || (c.req.method === 'POST' && id !== undefined)) return c.json({ error: 'not found' }, 404)
    const parsed = ProviderWriteInputSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    try {
      const result = await writeProvider(ctx, userId, parsed.data, id)
      if (result.warning) c.header('X-Provider-Association-Warning', result.warning)
      return c.json(result.provider, id === undefined ? 201 : 200)
    } catch (error) {
      if (error instanceof ProviderWriteError) return c.json({ error: error.message }, error.status)
      throw error
    }
  })

  r.delete('/providers/:id', async c => {
    const userId = authUserId(c)
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'not found' }, 404)
    const provider = await db.query.providers.findFirst({ where: owned(id, userId) })
    if (!provider) return c.json({ error: 'not found' }, 404)
    const interfaces = await db.select().from(providerInterfaces).where(eq(providerInterfaces.provider_id, id))
    await cleanupProviderFilesBeforeChange(ctx, provider, interfaces, invalidatedProviderFiles(provider))
    await db.batch([
      db.delete(providers).where(owned(id, userId)),
      db.update(users).set({ enabled_models_revision: sql`${users.enabled_models_revision} + 1` }).where(eq(users.id, userId)),
    ])
    return c.body(null, 204)
  })

  r.post('/providers/:id/fetch-models', async c => {
    const userId = authUserId(c)
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'not found' }, 404)
    const provider = await db.query.providers.findFirst({ where: owned(id, userId) })
    if (!provider) return c.json({ error: 'not found' }, 404)
    const endpoint = provider.default_interface_id === null ? undefined : await db.query.providerInterfaces.findFirst({
      where: and(eq(providerInterfaces.id, provider.default_interface_id), eq(providerInterfaces.provider_id, id)),
    })
    if (!endpoint) return c.json({ error: 'Configure a default interface first' }, 400)
    if (endpoint.protocol === 'vertex-compatible') return c.json({ error: 'Model listing is not supported for Vertex-compatible interfaces' }, 400)
    const key = provider.api_key ? await decryptSecret(ctx.env.KEY_ENCRYPTION_SECRET, provider.api_key) : null
    // Stage durations only. Never log listing payloads, DB values or credentials.
    const timings = elapsed()
    const remote = await listRemoteModels(endpoint, key)
    const ids = [...new Set(remote.map(model => model.id))]
    const remoteById = new Map(remote.map(model => [model.id, model]))
    timings.mark('listing', { models: ids.length })
    try {
      return await retryModelSource(async () => {
        const currentProvider = await db.query.providers.findFirst({ where: owned(id, userId) })
        if (!currentProvider) return c.json({ error: 'not found' }, 404)
        const existing = await db.select(modelSourceColumns).from(models).where(eq(models.provider_id, id))
        const catalog = await catalogForModels(ctx, currentProvider.models_dev_provider_id, [...ids, ...existing.map(model => model.model_id)])
        timings.mark('catalog', { stored: existing.length })
        const operations: BatchItem<'sqlite'>[] = [providerSourceFence(db, currentProvider, catalog.version, existing)]
        const existingIds = new Set(existing.map(model => model.model_id))
        const returnedIds = new Set(ids)
        const missing = ids.filter(modelId => !existingIds.has(modelId))
        const insertResultIndexes: number[] = []
        for (const model_id of missing) {
          insertResultIndexes.push(operations.length)
          operations.push(db.insert(models).values({
            provider_id: id, model_id, enabled: false, manual_pinned: false, upstream_available: true,
            ...resolveModelFields(catalog, currentProvider.models_dev_provider_id, model_id, {}, remoteById.get(model_id)?.metadata),
            provider_metadata: remoteById.get(model_id)?.providerMetadata ?? {},
          }).onConflictDoNothing().returning({ id: models.id }))
        }
        let removed = 0
        let unavailable = 0
        for (const model of existing) {
          const upstreamAvailable = returnedIds.has(model.model_id)
          operations.push(modelSourceFence(db, model, currentProvider, catalog.version))
          if (!upstreamAvailable && !model.manual_pinned && !model.enabled) {
            removed++
            operations.push(db.delete(models).where(modelSourceMatches(model, currentProvider, catalog.version)))
            continue
          }
          if (!upstreamAvailable) unavailable++
          const changed = changedModelFields(model, {
            upstream_available: upstreamAvailable,
            ...resolveModelFields(catalog, currentProvider.models_dev_provider_id, model.model_id, model.metadata_override, remoteById.get(model.model_id)?.metadata),
            ...(remoteById.get(model.model_id) ? { provider_metadata: remoteById.get(model.model_id)!.providerMetadata } : {}),
          })
          if (Object.keys(changed).length) operations.push(db.update(models).set(changed).where(modelSourceMatches(model, currentProvider, catalog.version)))
        }
        operations.push(...bumpModelListRevisions(db, userId, id))
        timings.mark('prepare', { statements: operations.length })
        const results = await db.batch(operations as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
        timings.mark('batch')
        const imported = insertResultIndexes.reduce((count, index) => count + (results[index] as unknown[]).length, 0)
        console.log('Provider model listing timings', { provider_id: id, ...timings.report() })
        return c.json({ imported, removed, unavailable, models: ids })
      })
    } catch (error) {
      if (error instanceof ModelSourceConflict) return c.json({ error: error.message }, 409)
      throw error
    }
  })

  return r
}
