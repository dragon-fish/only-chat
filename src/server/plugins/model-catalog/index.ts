import { Context, Service } from 'cordis'
import { refreshCatalog, type CatalogRefreshResult } from './refresh'
import { CatalogStorage } from './storage'
import type { CatalogModel, CatalogProviderIndex } from './types'

export type { CatalogRefreshResult } from './refresh'

export interface CatalogStatus {
  version: string | null
  previousVersion: string | null
  lastSuccessAt: number | null
  lastError: string | null
}

export class ModelCatalog extends Service {
  static readonly provide = 'modelCatalog'
  static readonly inject = ['env', 'db']
  private readonly storage: CatalogStorage
  private refreshing: Promise<CatalogRefreshResult> | undefined

  constructor(ctx: Context) {
    super(ctx, 'modelCatalog')
    this.storage = new CatalogStorage(ctx.env.MODEL_CATALOG)
  }

  async refresh(source: 'cron' | 'manual'): Promise<CatalogRefreshResult> {
    this.refreshing ??= refreshCatalog(this.storage, this.ctx.db.orm).finally(() => { this.refreshing = undefined })
    try {
      return await this.refreshing
    } finally {
      if (source === 'cron') {
        try {
          await this.storage.collectGarbage(Date.now())
        } catch (error) {
          console.error('Catalog garbage collection failed', error)
        }
      }
    }
  }

  async status(): Promise<CatalogStatus> {
    const [pointer, state] = await Promise.all([this.storage.pointer(), this.storage.refreshState()])
    const manifest = pointer ? await this.storage.manifest(pointer.current) : null
    return {
      version: pointer?.current ?? null,
      previousVersion: pointer?.previous ?? null,
      lastSuccessAt: state?.lastSuccessAt ?? manifest?.fetchedAt ?? null,
      lastError: state?.lastError ?? null,
    }
  }

  async providerIndex(): Promise<CatalogProviderIndex> {
    return await this.storage.readShard<CatalogProviderIndex>('providers') ?? {}
  }

  async globalModels(version: string): Promise<Record<string, CatalogModel>> {
    return await this.storage.readShard<Record<string, CatalogModel>>('models', version) ?? {}
  }

  async providerModels(id: string, version: string): Promise<Record<string, CatalogModel>> {
    return await this.storage.readShard<Record<string, CatalogModel>>(`provider:${id}`, version) ?? {}
  }
}
