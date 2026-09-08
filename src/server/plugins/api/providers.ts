import type { Context } from 'cordis'
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { ProviderWriteInputSchema } from '@/shared/api'
import { models, providerInterfaces, providers } from '../../db/schema'
import { decryptSecret } from '../llm/crypto'
import { listRemoteModels } from '../llm/list-models'
import { cleanupProviderFilesBeforeChange, invalidatedProviderFiles } from '../files-cleanup'
import { parseId } from './params'
import { ProviderWriteError, toProviderDto, writeProvider } from './provider-write'
import { catalogForModels, materializationUpdates, ModelSourceConflict, modelSourceColumns, providerSourceFence, resolveModelFields, retryModelSource } from './model-write'

export function providerRoutes(ctx: Context) {
  const r = new Hono<{ Bindings: Env }>()
  const db = ctx.db.orm
  const owned = (id: number) => and(eq(providers.id, id), eq(providers.user_id, DEFAULT_USER_ID))

  r.get('/providers', async c => {
    const rows = await db.select().from(providers).where(eq(providers.user_id, DEFAULT_USER_ID)).orderBy(providers.id)
    const endpoints = await db.select({ interface: providerInterfaces }).from(providerInterfaces)
      .innerJoin(providers, eq(providers.id, providerInterfaces.provider_id)).where(eq(providers.user_id, DEFAULT_USER_ID))
      .orderBy(providerInterfaces.id)
    return c.json(rows.map(row => toProviderDto(row, endpoints.filter(endpoint => endpoint.interface.provider_id === row.id).map(endpoint => endpoint.interface))))
  })

  r.on(['POST', 'PUT'], ['/providers', '/providers/:id'], async c => {
    const id = c.req.param('id') === undefined ? undefined : parseId(c.req.param('id')!)
    if (id === null || (c.req.method === 'PUT' && id === undefined) || (c.req.method === 'POST' && id !== undefined)) return c.json({ error: 'not found' }, 404)
    const parsed = ProviderWriteInputSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    try {
      const result = await writeProvider(ctx, parsed.data, id)
      if (result.warning) c.header('X-Provider-Association-Warning', result.warning)
      return c.json(result.provider, id === undefined ? 201 : 200)
    } catch (error) {
      if (error instanceof ProviderWriteError) return c.json({ error: error.message }, error.status)
      throw error
    }
  })

  r.delete('/providers/:id', async c => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'not found' }, 404)
    const provider = await db.query.providers.findFirst({ where: owned(id) })
    if (provider) {
      const interfaces = await db.select().from(providerInterfaces).where(eq(providerInterfaces.provider_id, id))
      await cleanupProviderFilesBeforeChange(ctx, provider, interfaces, invalidatedProviderFiles(provider))
    }
    await db.delete(providers).where(owned(id))
    return c.body(null, 204)
  })

  r.post('/providers/:id/fetch-models', async c => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'not found' }, 404)
    const provider = await db.query.providers.findFirst({ where: owned(id) })
    if (!provider) return c.json({ error: 'not found' }, 404)
    const endpoint = provider.default_interface_id === null ? undefined : await db.query.providerInterfaces.findFirst({
      where: and(eq(providerInterfaces.id, provider.default_interface_id), eq(providerInterfaces.provider_id, id)),
    })
    if (!endpoint) return c.json({ error: 'Configure a default interface first' }, 400)
    if (endpoint.protocol === 'vertex-compatible') return c.json({ error: 'Model listing is not supported for Vertex-compatible interfaces' }, 400)
    const key = provider.api_key ? await decryptSecret(ctx.env.KEY_ENCRYPTION_SECRET, provider.api_key) : null
    const ids = [...new Set(await listRemoteModels(endpoint, key))]
    try {
      return await retryModelSource(async () => {
        const currentProvider = await db.query.providers.findFirst({ where: owned(id) })
        if (!currentProvider) return c.json({ error: 'not found' }, 404)
        const existing = await db.select(modelSourceColumns).from(models).where(eq(models.provider_id, id))
        const catalog = await catalogForModels(ctx, currentProvider.models_dev_provider_id, [...ids, ...existing.map(model => model.model_id)])
        const operations: BatchItem<'sqlite'>[] = [providerSourceFence(db, currentProvider, catalog.version, existing)]
        const existingIds = new Set(existing.map(model => model.model_id))
        const missing = ids.filter(modelId => !existingIds.has(modelId))
        for (const model_id of missing) {
          operations.push(db.insert(models).values({
            provider_id: id, model_id,
            ...resolveModelFields(catalog, currentProvider.models_dev_provider_id, model_id, {}),
          }).onConflictDoNothing().returning({ id: models.id }))
        }
        operations.push(...materializationUpdates(db, existing, catalog, currentProvider))
        const results = await db.batch(operations as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
        const imported = results.slice(1, missing.length + 1).reduce((count, result) => count + (result as unknown[]).length, 0)
        return c.json({ imported, models: ids })
      })
    } catch (error) {
      if (error instanceof ModelSourceConflict) return c.json({ error: error.message }, 409)
      throw error
    }
  })

  return r
}
