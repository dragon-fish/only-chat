import type { Context } from 'cordis'
import type { DB } from '@/server/db/client'
import { models, type ModelRow } from '@/server/db/schema'
import type { ModelMetadataOverride } from '@/shared/model-metadata'
import { ModelWithMetadataSchema, type ModelWithMetadata } from '@/shared/models'
import type { ModelCatalog } from '../model-catalog/types'
import { materializeModelMetadata, resolveModelMetadata } from '../model-catalog/resolve'
import { changedModelFields, modelSourceFence, modelSourceMatches, type ModelSourceRow, type ProviderSource } from '../model-catalog/source-snapshot'
export { changedModelFields, isModelSourceConflict, ModelSourceConflict, modelSourceColumns, modelSourceFence, modelSourceMatches, providerSourceFence, retryModelSource } from '../model-catalog/source-snapshot'

export type CatalogSnapshot = ModelCatalog & { version: string | null }

/** Read only the operator and relevant Lab shards, pinned to one published catalog version. */
export async function catalogForModels(ctx: Context, providerId: string | null, modelIds: readonly string[], requestedVersion?: string | null): Promise<CatalogSnapshot> {
  const version = requestedVersion === undefined ? (await ctx.modelCatalog.status()).version : requestedVersion
  if (!version) return { version: null, providers: {}, models: {} }
  return { ...await ctx.modelCatalog.materializationCatalog(version, providerId, modelIds), version }
}

export function resolveModelFields(catalog: ModelCatalog, providerId: string | null, modelId: string, override: ModelMetadataOverride) {
  const result = resolveModelMetadata({ catalog, providerId, modelId, metadataOverride: override })
  return {
    metadata_resolved: result.metadata, catalog_matches: result.matches, lab_id: result.labId,
    ...materializeModelMetadata(result.metadata, modelId, result.labName),
  }
}

export function materializationUpdates(db: DB, rows: ModelSourceRow[], catalog: CatalogSnapshot, provider: ProviderSource) {
  return rows.flatMap(row => {
    const changed = changedModelFields(row, resolveModelFields(catalog, provider.models_dev_provider_id, row.model_id, row.metadata_override))
    return [modelSourceFence(db, row, provider, catalog.version),
      ...(Object.keys(changed).length ? [db.update(models).set(changed).where(modelSourceMatches(row, provider, catalog.version))] : [])]
  })
}

export function toModelDto(row: ModelRow): ModelWithMetadata {
  return ModelWithMetadataSchema.parse({
    id: row.id, provider_id: row.provider_id, model_id: row.model_id, interface_id: row.interface_id,
    metadata: row.metadata_resolved, metadata_override: row.metadata_override, catalog_matches: row.catalog_matches,
    lab_id: row.lab_id, enabled: row.enabled, manual_pinned: row.manual_pinned,
    upstream_available: row.upstream_available, sort: row.sort,
  })
}
