import { APICallError } from '@ai-sdk/provider'
import type { Context } from 'cordis'
import { and, eq, lte, sql, type SQL } from 'drizzle-orm'
import { attachmentProviderFiles as pointers, providerInterfaces, providers, type AttachmentProviderFileRow, type ProviderInterfaceRow, type ProviderRow } from '../db/schema'
import { decryptSecret } from './llm/crypto'
import { createAnthropicFiles } from './llm/files/anthropic'
import { createOpenAIFiles } from './llm/files/openai'
import { FilesReferenceError, normalizeFilesBaseURL } from './llm/files/shared'
import type { ScopedFilesClient } from './llm/files/types'

export interface FileCleanupOptions {
  pageSize?: number
  concurrency?: number
  maxFiles?: number
  requestTimeoutMs?: number
}

export interface FileCleanupResult {
  processed: number
  deleted: number
  pruned: number
  retried: number
}

type Endpoint = Pick<ProviderInterfaceRow, 'protocol' | 'base_url'>
type FileScope = Pick<ScopedFilesClient, 'family' | 'baseURL'>
type CleanupContext = Pick<Context, 'db' | 'env'>

function endpointScope(endpoint: Endpoint): FileScope | null {
  if (endpoint.protocol === 'vertex-compatible') return null
  const family = endpoint.protocol === 'anthropic' ? 'anthropic' : 'openai'
  return { family, baseURL: normalizeFilesBaseURL(endpoint.base_url, family) }
}

function sameScope(a: FileScope, b: FileScope) {
  return a.family === b.family && a.baseURL === b.baseURL
}

/** Only classification fields can enter D1 or logs; provider errors may embed credentials. */
export function fileCleanupError(error: unknown): string {
  if (error instanceof FilesReferenceError) return 'Unusable provider file reference'
  const status = APICallError.isInstance(error) ? error.statusCode : undefined
  return status === undefined ? 'Provider file deletion failed' : `Provider file deletion failed (HTTP ${status})`
}

function logPruned(row: AttachmentProviderFileRow, reason: string) {
  console.warn('Provider file reference discarded', { pointerId: row.id, providerId: row.provider_id, reason })
}

async function cleanupFiles(ctx: CleanupContext, now: number, where: SQL, options: FileCleanupOptions, snapshot?: { provider: ProviderRow; interfaces: ProviderInterfaceRow[] }): Promise<FileCleanupResult> {
  const { pageSize = 50, concurrency = 4, maxFiles = 100, requestTimeoutMs = 10_000 } = options
  for (const value of [pageSize, concurrency, maxFiles, requestTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('File cleanup limits must be positive integers')
  }
  const db = ctx.db.orm
  const result: FileCleanupResult = { processed: 0, deleted: 0, pruned: 0, retried: 0 }
  // Request-local promises share both decryption and client construction for each upload scope.
  const clients = new Map<string, Promise<ScopedFilesClient | null>>()
  function clientFor(row: AttachmentProviderFileRow) {
    const key = JSON.stringify([row.provider_id, row.credential_version, row.file_family, row.base_url])
    let client = clients.get(key)
    if (!client) {
      client = (async () => {
        const provider = snapshot?.provider ?? await db.query.providers.findFirst({ where: eq(providers.id, row.provider_id) })
        if (!provider || !provider.api_key || provider.credential_version !== row.credential_version) return null
        const interfaces = snapshot?.interfaces ?? await db.select().from(providerInterfaces).where(eq(providerInterfaces.provider_id, row.provider_id))
        const scope = { family: row.file_family, baseURL: row.base_url }
        if (!interfaces.some(endpoint => {
          try { const current = endpointScope(endpoint); return current !== null && sameScope(current, scope) } catch { return false }
        })) return null
        const settings = { baseURL: row.base_url, credentialVersion: row.credential_version, apiKey: await decryptSecret(ctx.env.KEY_ENCRYPTION_SECRET, provider.api_key) }
        return row.file_family === 'openai' ? createOpenAIFiles(settings) : createAnthropicFiles(settings)
      })()
      clients.set(key, client)
    }
    return client
  }
  async function cleanup(row: AttachmentProviderFileRow) {
    let disposition: 'deleted' | 'pruned' | 'retried' = 'deleted'
    let reason = ''
    try {
      try { row.base_url = normalizeFilesBaseURL(row.base_url, row.file_family) } catch { throw new FilesReferenceError() }
      const client = await clientFor(row)
      if (!client?.files.deleteFile) {
        disposition = 'pruned'
        reason = 'Upload credentials or interface are no longer available'
      } else {
        const deleted = await client.files.deleteFile({ file: row.provider_reference, abortSignal: AbortSignal.timeout(requestTimeoutMs) })
        if (!deleted.deleted) throw new Error('Provider did not confirm file deletion')
      }
    } catch (error) {
      const status = APICallError.isInstance(error) ? error.statusCode : undefined
      reason = fileCleanupError(error)
      if (status === 404 || status === 410) disposition = 'deleted'
      else if (APICallError.isInstance(error) && error.isRetryable) disposition = 'retried'
      else if (error instanceof FilesReferenceError || (status !== undefined && status >= 400 && status < 500 && ![401, 403, 429].includes(status))) disposition = 'pruned'
      else disposition = 'retried'
    }
    if (disposition === 'retried') {
      await db.update(pointers).set({
        base_url: row.base_url, cleanup_attempts: sql`${pointers.cleanup_attempts} + 1`, cleanup_after: now + 86_400_000, last_cleanup_error: reason,
      }).where(eq(pointers.id, row.id))
    } else {
      if (disposition === 'pruned') logPruned(row, reason)
      await db.delete(pointers).where(eq(pointers.id, row.id))
    }
    result[disposition]++
    result.processed++
  }
  // Each completed row is deleted or deferred beyond this run, so no OFFSET can skip survivors.
  // Pre-change sweeps use an ID cursor because they also include live/retry-deferred pointers.
  let cursor = 0
  while (result.processed < maxFiles) {
    const rows = await db.select().from(pointers).where(and(where, snapshot ? sql`${pointers.id} > ${cursor}` : undefined))
      .orderBy(...(snapshot ? [pointers.id] : [pointers.cleanup_after, pointers.expires_at, pointers.id]))
      .limit(Math.min(pageSize, maxFiles - result.processed))
    if (!rows.length) break
    let index = 0
    const workers = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
      while (index < rows.length) await cleanup(rows[index++]!)
    })
    const outcomes = await Promise.allSettled(workers)
    if (outcomes.some(outcome => outcome.status === 'rejected')) throw new Error('Provider file cleanup storage operation failed')
    cursor = rows.at(-1)!.id
  }
  return result
}

export function cleanupExpiredProviderFiles(ctx: CleanupContext, now: number, options: FileCleanupOptions = {}): Promise<FileCleanupResult> {
  return cleanupFiles(ctx, now, and(lte(pointers.cleanup_after, now), lte(pointers.expires_at, now))!, options)
}

/** Normalize stored identities before the configuration transaction compares them in SQL. */
export async function normalizeProviderFileScopes(ctx: CleanupContext, provider: ProviderRow): Promise<void> {
  const db = ctx.db.orm
  let cursor = 0
  for (;;) {
    const rows = await db.select({ id: pointers.id, file_family: pointers.file_family, base_url: pointers.base_url }).from(pointers)
      .where(and(eq(pointers.provider_id, provider.id), lte(pointers.credential_version, provider.credential_version), sql`${pointers.id} > ${cursor}`))
      .orderBy(pointers.id).limit(50)
    if (!rows.length) return
    for (const row of rows) {
      let baseURL: string
      try { baseURL = normalizeFilesBaseURL(row.base_url, row.file_family) } catch { continue }
      if (baseURL !== row.base_url) await db.update(pointers).set({ base_url: baseURL }).where(eq(pointers.id, row.id))
    }
    cursor = rows.at(-1)!.id
  }
}

/** The SQL predicate is also applied inside the configuration transaction to discard failed old references. */
export function invalidatedProviderFiles(provider: ProviderRow, nextInterfaces?: Endpoint[], keyChanged = false): SQL {
  const retained: FileScope[] = []
  for (const endpoint of nextInterfaces ?? []) {
    try { const scope = endpointScope(endpoint); if (scope) retained.push(scope) } catch { /* Invalid endpoints cannot retain a file scope. */ }
  }
  return and(eq(pointers.provider_id, provider.id), lte(pointers.credential_version, provider.credential_version), keyChanged || nextInterfaces === undefined
    ? undefined
    : sql`NOT (${pointers.credential_version} = ${provider.credential_version} AND (${retained.length
      ? sql.join(retained.map(scope => sql`(${pointers.file_family} = ${scope.family} AND ${pointers.base_url} = ${scope.baseURL})`), sql` OR `)
      : sql`0`}))`)!
}

export async function cleanupProviderFilesBeforeChange(ctx: CleanupContext, provider: ProviderRow, interfaces: ProviderInterfaceRow[], where: SQL): Promise<void> {
  try {
    const result = await cleanupFiles(ctx, Date.now(), where, { requestTimeoutMs: 5_000 }, { provider, interfaces })
    if (result.retried || result.processed === 100) console.warn('Provider configuration invalidates pending remote file cleanup', { providerId: provider.id, retried: result.retried, limitReached: result.processed === 100 })
  } catch {
    console.warn('Provider configuration remote file cleanup failed', { providerId: provider.id })
  }
}
