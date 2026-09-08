import { eq } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { DB } from '@/server/db/client'
import { models, providerInterfaces, providers } from '@/server/db/schema'
import { matchProviderByEndpoints } from './match'
import { materializeModelMetadata, resolveModelMetadata } from './resolve'
import { CatalogStorage, projectProviderIndex, type CatalogCounts } from './storage'
import { parseModelCatalog, type ModelCatalog } from './types'
import { CatalogLease, CatalogLeaseLostError } from './lease'
import { catalogProviderSetFence, changedModelFields, ModelSourceConflict, modelSourceColumns, modelSourceFence, modelSourceMatches, providerSourceFence, retryModelSource } from './source-snapshot'

export interface CatalogRefreshResult extends CatalogCounts {
  version: string
  changed: boolean
}

async function materialize(db: DB, catalog: ModelCatalog, version: string | null): Promise<BatchItem<'sqlite'>[]> {
  const [storedProviders, interfaces, storedModels] = await Promise.all([
    db.select().from(providers), db.select().from(providerInterfaces), db.select(modelSourceColumns).from(models),
  ])
  const providerIndex = projectProviderIndex(catalog)
  const associations = new Map<number, { id: number; models_dev_provider_id: string | null; models_dev_provider_source: 'manual' | 'endpoint' }>()
  const updates: BatchItem<'sqlite'>[] = [catalogProviderSetFence(db, storedProviders)]
  for (const provider of storedProviders) {
    const match = matchProviderByEndpoints({
      defaultInterfaceId: provider.default_interface_id,
      interfaces: interfaces.filter(endpoint => endpoint.provider_id === provider.id),
      modelsDevProviderId: provider.models_dev_provider_id,
      modelsDevProviderSource: provider.models_dev_provider_source,
    }, providerIndex)
    associations.set(provider.id, { id: provider.id, models_dev_provider_id: match.id, models_dev_provider_source: match.source })
    updates.push(providerSourceFence(db, provider, version, storedModels.filter(model => model.provider_id === provider.id), interfaces.filter(endpoint => endpoint.provider_id === provider.id)))
    updates.push(db.update(providers).set({
      models_dev_provider_id: match.id,
      models_dev_provider_source: match.source,
    }).where(eq(providers.id, provider.id)))
  }
  for (const model of storedModels) {
    const source = associations.get(model.provider_id)
    if (!source) throw new ModelSourceConflict()
    const resolved = resolveModelMetadata({
      providerId: source.models_dev_provider_id,
      modelId: model.model_id,
      metadataOverride: model.metadata_override,
      catalog,
    })
    const changed = changedModelFields(model, {
      metadata_resolved: resolved.metadata,
      catalog_matches: resolved.matches,
      lab_id: resolved.labId,
      ...materializeModelMetadata(resolved.metadata, model.model_id, resolved.labName),
    })
    updates.push(modelSourceFence(db, model, source, version))
    if (Object.keys(changed).length) updates.push(db.update(models).set(changed).where(modelSourceMatches(model, source, version)))
  }
  return updates
}

export async function refreshCatalog(storage: CatalogStorage, db: DB): Promise<CatalogRefreshResult> {
  const lease = await CatalogLease.acquire(db)
  try {
    return await refreshWithLease(storage, db, lease)
  } finally {
    await lease.release()
  }
}

async function refreshWithLease(storage: CatalogStorage, db: DB, lease: CatalogLease): Promise<CatalogRefreshResult> {
  let stage = 'download'
  let result: CatalogRefreshResult
  try {
    const response = await fetch('https://models.dev/catalog.json')
    if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`)
    const bytes = await response.arrayBuffer()
    stage = 'validation'
    const catalog = parseModelCatalog(JSON.parse(new TextDecoder().decode(bytes)))
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
    await lease.renew()
    stage = 'storage'
    const pointer = lease.pointer
    const active = pointer ? await storage.manifest(pointer.current) : null
    if (active?.hash === hash) {
      await lease.recordUnchangedSuccess()
      result = { version: active.version, changed: false, providers: active.providers, globalModels: active.globalModels, providerModels: active.providerModels }
    } else {
      const manifest = await storage.stage(catalog, hash, Date.now(), () => lease.renew())
      stage = 'materialization'
      await retryModelSource(async () => {
        await lease.renew()
        await lease.commit(await materialize(db, catalog, pointer?.current ?? null), { current: manifest.version, previous: pointer?.current ?? null })
      })
      result = { version: manifest.version, changed: true, providers: manifest.providers, globalModels: manifest.globalModels, providerModels: manifest.providerModels }
    }
  } catch (error) {
    if (error instanceof CatalogLeaseLostError) throw error
    // Keep status/API errors bounded and free of upstream payloads, DB values or credentials.
    const message = `Catalog refresh failed during ${stage}`
    try {
      await lease.recordFailure(message)
    } catch (error) {
      console.error('Could not record catalog refresh failure', error)
    }
    throw new Error(message)
  }
  return result
}
