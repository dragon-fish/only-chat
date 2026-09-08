import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { DB } from '@/server/db/client'
import { modelCatalogRefresh } from '@/server/db/schema'
import type { CatalogPointer } from './storage'

const LEASE_DURATION_MS = 60 * 1000

export class CatalogRefreshBusyError extends Error {
  constructor() { super('Catalog refresh already in progress') }
}

export class CatalogLeaseLostError extends Error {
  constructor() { super('Catalog refresh lease expired') }
}

export async function publicationState(db: DB) {
  const [state] = await db.select().from(modelCatalogRefresh).where(eq(modelCatalogRefresh.id, 1))
  return state
}

export async function publicationPointer(db: DB): Promise<CatalogPointer | null> {
  const state = await publicationState(db)
  return state?.current_version ? { current: state.current_version, previous: state.previous_version } : null
}

export class CatalogLease {
  private constructor(private readonly db: DB, private readonly owner: string, public pointer: CatalogPointer | null) {}

  static async acquire(db: DB): Promise<CatalogLease> {
    const now = Date.now()
    const owner = crypto.randomUUID()
    const [state] = await db.insert(modelCatalogRefresh).values({ id: 1, owner, expires_at: now + LEASE_DURATION_MS })
      .onConflictDoUpdate({
        target: modelCatalogRefresh.id,
        set: { owner, expires_at: now + LEASE_DURATION_MS },
        setWhere: or(isNull(modelCatalogRefresh.owner), lte(modelCatalogRefresh.expires_at, now)),
      }).returning()
    if (!state) throw new CatalogRefreshBusyError()
    return new CatalogLease(db, owner, state.current_version ? { current: state.current_version, previous: state.previous_version } : null)
  }

  private ownership(now = Date.now()) {
    return and(eq(modelCatalogRefresh.id, 1), eq(modelCatalogRefresh.owner, this.owner), gt(modelCatalogRefresh.expires_at, now))
  }

  async renew(): Promise<void> {
    const now = Date.now()
    const renewed = await this.db.update(modelCatalogRefresh).set({ expires_at: now + LEASE_DURATION_MS }).where(this.ownership(now)).returning({ id: modelCatalogRefresh.id })
    if (renewed.length === 0) throw new CatalogLeaseLostError()
  }

  async commit(updates: BatchItem<'sqlite'>[], pointer: CatalogPointer): Promise<void> {
    const now = Date.now()
    // The NOT NULL guard aborts the whole batch if ownership expired or changed during preparation.
    const fence = this.db.update(modelCatalogRefresh).set({
      expires_at: sql`CASE WHEN ${this.ownership(now)} THEN ${now + LEASE_DURATION_MS} ELSE NULL END`,
    }).where(eq(modelCatalogRefresh.id, 1))
    const publish = this.db.update(modelCatalogRefresh).set({
      current_version: pointer.current,
      previous_version: pointer.previous,
      last_success_at: now,
      last_error: null,
    }).where(eq(modelCatalogRefresh.id, 1))
    await this.db.batch([fence, ...updates, publish])
    this.pointer = pointer
  }

  private currentPublication() {
    return and(this.ownership(), this.pointer
      ? eq(modelCatalogRefresh.current_version, this.pointer.current)
      : isNull(modelCatalogRefresh.current_version))
  }

  async recordUnchangedSuccess(): Promise<void> {
    const updated = await this.db.update(modelCatalogRefresh).set({ last_success_at: Date.now(), last_error: null })
      .where(this.currentPublication()).returning({ id: modelCatalogRefresh.id })
    if (updated.length === 0) throw new CatalogLeaseLostError()
  }

  async recordFailure(message: string): Promise<void> {
    await this.db.update(modelCatalogRefresh).set({ last_error: message }).where(this.currentPublication())
  }

  async release(): Promise<void> {
    // Keep writer state after release; an expired owner must never release a replacement owner's lease.
    await this.db.update(modelCatalogRefresh).set({ owner: null, expires_at: 0 })
      .where(and(eq(modelCatalogRefresh.id, 1), eq(modelCatalogRefresh.owner, this.owner)))
  }
}
