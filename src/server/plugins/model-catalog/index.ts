import { Context, Service } from 'cordis'
import { refreshCatalog, type CatalogRefreshResult } from './refresh'
import { CatalogStorage } from './storage'
import type { CatalogModel, CatalogProviderIndex } from './types'
import { CatalogRefreshBusyError, publicationPointer, publicationState } from './lease'

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
    this.storage = new CatalogStorage(ctx.env.KV)
  }

  refresh(source: 'manual'): Promise<CatalogRefreshResult>
  refresh(source: 'cron'): Promise<CatalogRefreshResult | null>
  async refresh(source: 'cron' | 'manual'): Promise<CatalogRefreshResult | null> {
    this.refreshing ??= refreshCatalog(this.storage, this.ctx.db.orm).finally(() => { this.refreshing = undefined })
    let busy = false
    try {
      return await this.refreshing
    } catch (error) {
      busy = error instanceof CatalogRefreshBusyError
      if (busy && source === 'cron') {
        console.info('Scheduled catalog refresh skipped: refresh already in progress')
        return null
      }
      throw error
    } finally {
      if (source === 'cron' && !busy) {
        try {
          await this.storage.collectGarbage(Date.now(), await publicationPointer(this.ctx.db.orm))
        } catch (error) {
          console.error('Catalog garbage collection failed', error)
        }
      }
    }
  }

  async status(): Promise<CatalogStatus> {
    const state = await publicationState(this.ctx.db.orm)
    return {
      version: state?.current_version ?? null,
      previousVersion: state?.previous_version ?? null,
      lastSuccessAt: state?.last_success_at ?? null,
      lastError: state?.last_error ?? null,
    }
  }

  materializationCatalog(version: string, providerId: string | null, modelIds: readonly string[]) {
    return this.storage.materializationCatalog(version, providerId, modelIds)
  }

  async providerIndex(version?: string): Promise<CatalogProviderIndex> {
    return await this.storage.readShard<CatalogProviderIndex>('providers', await publicationPointer(this.ctx.db.orm), version) ?? {}
  }

  async globalModels(version: string): Promise<Record<string, CatalogModel>> {
    return await this.storage.readShard<Record<string, CatalogModel>>('models', await publicationPointer(this.ctx.db.orm), version) ?? {}
  }

  async providerModels(id: string, version: string): Promise<Record<string, CatalogModel>> {
    return await this.storage.readShard<Record<string, CatalogModel>>(`provider:${id}`, await publicationPointer(this.ctx.db.orm), version) ?? {}
  }
}
