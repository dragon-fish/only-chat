import type { Context } from 'cordis'
import { eq } from 'drizzle-orm'
import type { DB } from '@/server/db/client'
import { models, type ModelRow } from '@/server/db/schema'
import type { ModelMetadataOverride } from '@/shared/model-metadata'
import { ModelWithMetadataSchema, type ModelWithMetadata } from '@/shared/models'
import type { ModelCatalog } from '../model-catalog/types'
import { materializeModelMetadata, resolveModelMetadata } from '../model-catalog/resolve'

/** Read only the operator and relevant Lab shards, pinned to one published catalog version. */
export async function catalogForModels(ctx: Context, providerId: string | null, modelIds: readonly string[]): Promise<ModelCatalog> {
  const status = await ctx.modelCatalog.status()
  if (!status.version) return { providers: {}, models: {} }
  const [index, globalModels] = await Promise.all([
    ctx.modelCatalog.providerIndex(status.version), ctx.modelCatalog.globalModels(status.version),
  ])
  const ids = new Set(modelIds.filter(id => id.includes('/')).map(id => id.slice(0, id.indexOf('/'))))
  if (providerId) ids.add(providerId)
  const catalog: ModelCatalog = {
    providers: Object.fromEntries(Object.values(index).map(provider => [provider.id, { ...provider, models: {} }])),
    models: globalModels,
  }
  await Promise.all([...ids].filter(id => index[id]).map(async id => {
    catalog.providers[id]!.models = await ctx.modelCatalog.providerModels(id, status.version!)
  }))
  return catalog
}

export function resolveModelFields(catalog: ModelCatalog, providerId: string | null, modelId: string, override: ModelMetadataOverride) {
  const result = resolveModelMetadata({ catalog, providerId, modelId, metadataOverride: override })
  return {
    metadata_resolved: result.metadata, catalog_matches: result.matches, lab_id: result.labId,
    ...materializeModelMetadata(result.metadata, modelId, result.labName),
  }
}

export function changedModelFields(row: ModelRow, next: Partial<ModelRow>): Partial<ModelRow> {
  return Object.fromEntries(Object.entries(next).filter(([key, value]) => JSON.stringify(row[key as keyof ModelRow]) !== JSON.stringify(value)))
}

export function materializationUpdates(db: DB, rows: ModelRow[], catalog: ModelCatalog, providerId: string | null) {
  return rows.flatMap(row => {
    const changed = changedModelFields(row, resolveModelFields(catalog, providerId, row.model_id, row.metadata_override))
    return Object.keys(changed).length ? [db.update(models).set(changed).where(eq(models.id, row.id))] : []
  })
}

export function toModelDto(row: ModelRow): ModelWithMetadata {
  return ModelWithMetadataSchema.parse({
    id: row.id, provider_id: row.provider_id, model_id: row.model_id, interface_id: row.interface_id,
    metadata: row.metadata_resolved, metadata_override: row.metadata_override, catalog_matches: row.catalog_matches,
    lab_id: row.lab_id, enabled: row.enabled, sort: row.sort,
  })
}
