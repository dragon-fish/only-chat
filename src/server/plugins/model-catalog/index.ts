import { Context, Service } from 'cordis'
import { refreshCatalog, type CatalogRefreshResult } from './refresh'
import { CatalogStorage } from './storage'
import type { CatalogModel, CatalogProviderIndex } from './types'
import { CatalogRefreshBusyError, publicationPointer } from './lease'

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
