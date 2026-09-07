import type { CatalogProviderIndex, ModelCatalog } from './types'

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

export interface CatalogRefreshState {
  lastSuccessAt: number | null
  lastError: string | null
}

export function projectProviderIndex(catalog: ModelCatalog): CatalogProviderIndex {
  return Object.fromEntries(Object.entries(catalog.providers).map(([id, provider]) => {
    const { models: _models, ...metadata } = provider
    return [id, metadata]
  }))
}

export class CatalogStorage {
  constructor(private readonly kv: KVNamespace) {}

  pointer() {
    return this.kv.get<CatalogPointer>('models-dev:active', 'json')
  }

  manifest(version: string) {
    return this.kv.get<CatalogManifest>(`models-dev:${version}:manifest`, 'json')
  }

  refreshState() {
    return this.kv.get<CatalogRefreshState>('models-dev:status', 'json')
  }

  recordRefresh(state: CatalogRefreshState) {
    return this.kv.put('models-dev:status', JSON.stringify(state))
  }

  async stage(catalog: ModelCatalog, hash: string, fetchedAt: number): Promise<CatalogManifest> {
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
    for (const [key, data] of shards) await this.kv.put(key, JSON.stringify(data), { metadata: { fetchedAt } })
    await this.kv.put(`${prefix}manifest`, JSON.stringify(manifest), { metadata: { fetchedAt } })
    return manifest
  }

  activate(pointer: CatalogPointer) {
    return this.kv.put('models-dev:active', JSON.stringify(pointer))
  }

  async readShard<T>(shard: string, version?: string): Promise<T | null> {
    const pointer = await this.pointer()
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

  async collectGarbage(now: number): Promise<void> {
    let cursor: string | undefined
    do {
      const page = await this.kv.list<{ fetchedAt: number }>({ prefix: 'models-dev:', cursor })
      const pointer = await this.pointer()
      for (const key of page.keys) {
        const generation = /^models-dev:([^:]+):/u.exec(key.name)?.[1]
        if (!generation || generation === pointer?.current || generation === pointer?.previous) continue
        if (typeof key.metadata?.fetchedAt !== 'number' || now - key.metadata.fetchedAt <= 48 * 60 * 60 * 1000) continue
        await this.kv.delete(key.name)
      }
      cursor = page.list_complete ? undefined : page.cursor
    } while (cursor !== undefined)
  }
}
