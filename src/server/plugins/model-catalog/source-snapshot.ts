import { and, eq, getTableColumns, not, sql } from 'drizzle-orm'
import type { DB } from '@/server/db/client'
import { models, providerInterfaces, providers, type ModelRow, type ProviderInterfaceRow, type ProviderRow } from '@/server/db/schema'

export type ProviderSource = Pick<ProviderRow, 'id' | 'models_dev_provider_id' | 'models_dev_provider_source'> & Partial<Pick<ProviderRow, 'default_interface_id'>>
export type ModelSourceRow = ModelRow & { metadata_override_snapshot: string }
export const modelSourceColumns = {
  ...getTableColumns(models),
  // Compare the stored bytes, not re-encoded JSON: legacy formatting such as 3.0 is valid.
  metadata_override_snapshot: sql<string>`${models.metadata_override}`.as('metadata_override_snapshot'),
}

export function changedModelFields(row: ModelRow, next: Partial<ModelRow>): Partial<ModelRow> {
  return Object.fromEntries(Object.entries(next).filter(([key, value]) => JSON.stringify(row[key as keyof ModelRow]) !== JSON.stringify(value)))
}

export class ModelSourceConflict extends Error {
  constructor() { super('Model metadata changed concurrently; retry the operation') }
}

export function isModelSourceConflict(error: unknown): boolean {
  let cause = error
  while (cause instanceof Error) {
    if (cause instanceof ModelSourceConflict || cause.message.includes('NOT NULL constraint failed: providers.created_at')) return true
    cause = cause.cause
  }
  return false
}

export async function retryModelSource<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await operation() }
    catch (error) { if (!isModelSourceConflict(error)) throw error }
  }
  throw new ModelSourceConflict()
}

function providerSourceMatches(provider: ProviderSource, version: string | null) {
  return and(sql`EXISTS (SELECT 1 FROM ${providers} WHERE ${providers.id} = ${provider.id}
    AND ${providers.models_dev_provider_id} IS ${provider.models_dev_provider_id}
    AND ${providers.models_dev_provider_source} IS ${provider.models_dev_provider_source})`,
    sql`(SELECT current_version FROM model_catalog_refresh WHERE id = 1) IS ${version}`,
    provider.default_interface_id === undefined ? undefined : sql`(SELECT default_interface_id FROM ${providers} WHERE id = ${provider.id}) IS ${provider.default_interface_id}`)!
}

export function catalogProviderSetFence(db: DB, rows: readonly ProviderRow[]) {
  const expected = rows.map(provider => provider.id).sort((a, b) => a - b).join(',') || null
  return db.update(providers).set({ created_at: sql`NULL` }).where(sql`(SELECT group_concat(id, ',') FROM (SELECT id FROM ${providers} ORDER BY id)) IS NOT ${expected}`)
}

export function providerSourceFence(db: DB, provider: ProviderSource, version: string | null, rows?: readonly ModelRow[], interfaces?: readonly ProviderInterfaceRow[]) {
  const matches = and(providerSourceMatches(provider, version),
    rows === undefined ? undefined : sql`(SELECT count(*) FROM ${models} WHERE ${models.provider_id} = ${provider.id}) = ${rows.length}`,
    interfaces === undefined ? undefined : and(
      sql`(SELECT count(*) FROM ${providerInterfaces} WHERE ${providerInterfaces.provider_id} = ${provider.id}) = ${interfaces.length}`,
      ...interfaces.map(endpoint => sql`EXISTS (SELECT 1 FROM ${providerInterfaces} WHERE id = ${endpoint.id} AND provider_id = ${provider.id} AND base_url = ${endpoint.base_url})`),
    ))
  // Only stale sources match this UPDATE. Its NOT NULL violation aborts the entire atomic batch.
  return db.update(providers).set({ created_at: sql`NULL` }).where(and(eq(providers.id, provider.id), not(matches!)))
}

export function modelSourceMatches(row: ModelSourceRow, provider: ProviderSource, version: string | null) {
  return and(eq(models.id, row.id), eq(models.provider_id, row.provider_id), eq(models.model_id, row.model_id),
    sql`${models.interface_id} IS ${row.interface_id}`, eq(models.enabled, row.enabled), eq(models.manual_pinned, row.manual_pinned),
    sql`${models.upstream_available} IS ${row.upstream_available}`, eq(models.sort, row.sort),
    sql`${models.metadata_override} = ${row.metadata_override_snapshot}`, providerSourceMatches(provider, version))!
}

export function modelSourceFence(db: DB, row: ModelSourceRow, provider: ProviderSource, version: string | null) {
  // Guard through the owning provider so deletion/replacement of a snapshotted model also forces a reread.
  return db.update(providers).set({ created_at: sql`NULL` }).where(and(eq(providers.id, provider.id),
    not(sql`EXISTS (SELECT 1 FROM ${models} WHERE ${modelSourceMatches(row, provider, version)})`)))
}
