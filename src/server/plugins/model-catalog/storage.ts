import type { CatalogModel, CatalogProviderIndex, ModelCatalog } from './types'

export interface CatalogPointer {
  current: string
  previous: string | null
}

export interface CatalogCounts {
  providers: number
  globalModels: number
  providerModels: number
}

export interface CatalogManifest extends CatalogCounts {
  version: string
  hash: string
  fetchedAt: number
  schemaVersion: 1
  shards: string[]
}

export class CatalogUnavailableError extends Error {
  constructor() { super('Current model catalog is unavailable; retry the operation') }
}

export function projectProviderIndex(catalog: ModelCatalog): CatalogProviderIndex {
  return Object.fromEntries(Object.entries(catalog.providers).map(([id, provider]) => {
    const { models: _models, ...metadata } = provider
    return [id, metadata]
  }))
}

export class CatalogStorage {
  constructor(private readonly kv: KVNamespace) {}

  manifest(version: string) {
    return this.kv.get<CatalogManifest>(`models-dev:${version}:manifest`, 'json')
  }

  async stage(catalog: ModelCatalog, hash: string, fetchedAt: number, checkpoint?: () => Promise<void>): Promise<CatalogManifest> {
    // Separate attempts must never overwrite each other's staging shards, even within one millisecond.
    const version = `${fetchedAt}-${hash}-${crypto.randomUUID()}`
    const prefix = `models-dev:${version}:`
    const shards: [string, unknown][] = [
      [`${prefix}providers`, projectProviderIndex(catalog)],
      [`${prefix}models`, catalog.models],
      ...Object.entries(catalog.providers).map(([id, provider]): [string, unknown] => [`${prefix}provider:${id}`, provider.models]),
    ]
    const manifest: CatalogManifest = {
      version, hash, fetchedAt, schemaVersion: 1,
      providers: Object.keys(catalog.providers).length,
      globalModels: Object.keys(catalog.models).length,
      providerModels: Object.values(catalog.providers).reduce((count, provider) => count + Object.keys(provider.models).length, 0),
      shards: shards.map(([key]) => key),
    }
    // Every staging key carries its age so interrupted writes can be collected without a manifest.
    for (const [index, [key, data]] of shards.entries()) {
      if (index % 20 === 0) await checkpoint?.()
      await this.kv.put(key, JSON.stringify(data), { metadata: { fetchedAt } })
    }
    await checkpoint?.()
    await this.kv.put(`${prefix}manifest`, JSON.stringify(manifest), { metadata: { fetchedAt } })
    return manifest
  }

  async readShard<T>(shard: string, pointer: CatalogPointer | null, version?: string): Promise<T | null> {
    const requested = version ?? pointer?.current
    if (!requested) return null
    const key = `models-dev:${requested}:${shard}`
    const result = await this.kv.get<T>(key, 'json')
    if (result !== null) return result
    // A provider removed from this generation is not a replication miss.
    if (shard.startsWith('provider:')) {
      const manifest = await this.manifest(requested)
      if (manifest && !manifest.shards.includes(key)) return null
    }
    if (requested !== pointer?.current || !pointer.previous) return null
    return this.kv.get<T>(`models-dev:${pointer.previous}:${shard}`, 'json')
  }

  /** Writes must use complete shards from their fenced D1 generation, never display fallback data. */
  async materializationCatalog(version: string, providerId: string | null, modelIds: readonly string[]): Promise<ModelCatalog> {
    try {
      const manifest = await this.manifest(version)
      if (!manifest || manifest.version !== version || manifest.schemaVersion !== 1 || !Array.isArray(manifest.shards)) throw new CatalogUnavailableError()
      const prefix = `models-dev:${version}:`
      const readRequired = async <T>(shard: string): Promise<T> => {
        const key = `${prefix}${shard}`
        if (!manifest.shards.includes(key)) throw new CatalogUnavailableError()
        const value = await this.kv.get<T>(key, 'json')
        if (value === null) throw new CatalogUnavailableError()
        return value
      }
      const [index, globalModels] = await Promise.all([
        readRequired<CatalogProviderIndex>('providers'), readRequired<Record<string, CatalogModel>>('models'),
      ])
      const providerIds = Object.keys(index)
      const expectedShards = ['providers', 'models', ...providerIds.map(id => `provider:${id}`)].map(shard => `${prefix}${shard}`)
      if (manifest.providers !== providerIds.length || manifest.globalModels !== Object.keys(globalModels).length
        || manifest.shards.length !== expectedShards.length || expectedShards.some(key => !manifest.shards.includes(key))
        || providerIds.some(id => index[id]?.id !== id)) throw new CatalogUnavailableError()
      const ids = new Set(modelIds.filter(id => id.includes('/')).map(id => id.slice(0, id.indexOf('/'))))
      if (providerId) ids.add(providerId)
      const catalog: ModelCatalog = {
        providers: Object.fromEntries(Object.entries(index).map(([id, provider]) => [id, { ...provider, models: {} }])),
        models: globalModels,
      }
      await Promise.all([...ids].filter(id => index[id]).map(async id => {
        catalog.providers[id]!.models = await readRequired<Record<string, CatalogModel>>(`provider:${id}`)
      }))
      return catalog
    } catch {
      // KV errors and inconsistent manifests must not leak storage payloads through the API.
      throw new CatalogUnavailableError()
    }
  }

  async collectGarbage(now: number, committed: CatalogPointer | null): Promise<void> {
    let cursor: string | undefined
    do {
      const page = await this.kv.list<{ fetchedAt: number }>({ prefix: 'models-dev:', cursor })
      for (const key of page.keys) {
        const generation = /^models-dev:([^:]+):/u.exec(key.name)?.[1]
        if (!generation || [committed?.current, committed?.previous].includes(generation)) continue
        if (typeof key.metadata?.fetchedAt !== 'number' || now - key.metadata.fetchedAt <= 48 * 60 * 60 * 1000) continue
        await this.kv.delete(key.name)
      }
      cursor = page.list_complete ? undefined : page.cursor
    } while (cursor !== undefined)
  }
}
