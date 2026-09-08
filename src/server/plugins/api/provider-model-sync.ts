import type { Context } from 'cordis'
import { and, eq } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { FetchModelsResponse } from '@/shared/api'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { models, providers } from '../../db/schema'
import { catalogForModels, changedModelFields, modelSourceColumns, modelSourceFence, modelSourceMatches, providerSourceFence, resolveModelFields, retryModelSource } from './model-write'

export class ProviderModelSyncNotFound extends Error {
  constructor() { super('not found') }
}

export async function reconcileProviderModels(ctx: Context, providerId: number, ids: readonly string[], options: { enableNew?: boolean } = {}): Promise<FetchModelsResponse> {
  const db = ctx.db.orm
  return await retryModelSource(async () => {
    const currentProvider = await db.query.providers.findFirst({
      where: and(eq(providers.id, providerId), eq(providers.user_id, DEFAULT_USER_ID)),
    })
    if (!currentProvider) throw new ProviderModelSyncNotFound()

    const existing = await db.select(modelSourceColumns).from(models).where(eq(models.provider_id, providerId))
    const catalog = await catalogForModels(ctx, currentProvider.models_dev_provider_id, [...ids, ...existing.map(model => model.model_id)])
    const operations: BatchItem<'sqlite'>[] = [providerSourceFence(db, currentProvider, catalog.version, existing)]
    const existingIds = new Set(existing.map(model => model.model_id))
    const returnedIds = new Set(ids)
    const missing = ids.filter(modelId => !existingIds.has(modelId))
    const insertResultIndexes: number[] = []
    for (const model_id of missing) {
      insertResultIndexes.push(operations.length)
      operations.push(db.insert(models).values({
        provider_id: providerId, model_id, enabled: options.enableNew === true, manual_pinned: false, upstream_available: true,
        ...resolveModelFields(catalog, currentProvider.models_dev_provider_id, model_id, {}),
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
        ...resolveModelFields(catalog, currentProvider.models_dev_provider_id, model.model_id, model.metadata_override),
      })
      if (Object.keys(changed).length) operations.push(db.update(models).set(changed).where(modelSourceMatches(model, currentProvider, catalog.version)))
    }
    const results = await db.batch(operations as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
    const imported = insertResultIndexes.reduce((count, index) => count + (results[index] as unknown[]).length, 0)
    return { imported, removed, unavailable, models: [...ids] }
  })
}
