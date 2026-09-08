import type { Context } from 'cordis'
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { DEFAULT_USER_ID } from '@/shared/constants'
import type { ProviderWriteInput } from '@/shared/api'
import { ProviderWithInterfacesSchema } from '@/shared/models'
import { attachmentProviderFiles, models, providerInterfaces, providers, type ProviderRow, type ProviderInterfaceRow } from '@/server/db/schema'
import { decryptSecret, encryptSecret } from '../llm/crypto'
import { matchProviderByEndpoints } from '../model-catalog/match'
import { cleanupProviderFilesBeforeChange, invalidatedProviderFiles, normalizeProviderFileScopes } from '../files-cleanup'
import { catalogForModels, isModelSourceConflict, materializationUpdates, ModelSourceConflict, modelSourceColumns, providerSourceFence, retryModelSource } from './model-write'

export class ProviderWriteError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message) }
}

export function toProviderDto(row: ProviderRow, interfaces: ProviderInterfaceRow[]) {
  return ProviderWithInterfacesSchema.parse({
    id: row.id, user_id: row.user_id, name: row.name, kind: 'custom', enabled: row.enabled, has_key: row.api_key !== null,
    default_interface_id: row.default_interface_id, credential_version: row.credential_version,
    models_dev_provider_id: row.models_dev_provider_id, models_dev_provider_source: row.models_dev_provider_source,
    interfaces, created_at: row.created_at,
  })
}

type CredentialExpectation = Readonly<Pick<ProviderRow, 'api_key' | 'credential_version'>>

export async function writeProvider(ctx: Context, input: ProviderWriteInput, id?: number) {
  let credentialExpectation: CredentialExpectation | undefined
  if (id !== undefined && input.api_key !== undefined) {
    const original = await ctx.db.orm.query.providers.findFirst({ where: and(eq(providers.id, id), eq(providers.user_id, DEFAULT_USER_ID)) })
    if (!original) throw new ProviderWriteError('not found', 404)
    // Source retries may refresh metadata, but must never adopt another request's credential version.
    credentialExpectation = { api_key: original.api_key, credential_version: original.credential_version }
  }
  try { return await retryModelSource(() => writeProviderAttempt(ctx, input, id, credentialExpectation)) }
  catch (error) {
    if (error instanceof ModelSourceConflict) throw new ProviderWriteError(error.message, 409)
    throw error
  }
}

async function writeProviderAttempt(ctx: Context, input: ProviderWriteInput, id: number | undefined, credentialExpectation: CredentialExpectation | undefined) {
  const db = ctx.db.orm
  const before = id === undefined ? undefined : await db.query.providers.findFirst({ where: and(eq(providers.id, id), eq(providers.user_id, DEFAULT_USER_ID)) })
  if (id !== undefined && !before) throw new ProviderWriteError('not found', 404)
  if (before && credentialExpectation && (before.credential_version !== credentialExpectation.credential_version || before.api_key !== credentialExpectation.api_key)) {
    throw new ProviderWriteError('Credentials changed concurrently; reload and retry', 409)
  }
  const existing = id === undefined ? [] : await db.select().from(providerInterfaces).where(eq(providerInterfaces.provider_id, id))
  for (const endpoint of input.interfaces) {
    if (endpoint.id !== undefined && !existing.some(row => row.id === endpoint.id && row.protocol === endpoint.protocol)) {
      throw new ProviderWriteError('Interface ID must belong to this provider and protocol')
    }
  }
  const protocols = input.interfaces.map(endpoint => endpoint.protocol)
  const removed = existing.filter(endpoint => !protocols.includes(endpoint.protocol))
  if (removed.length && (await db.select({ id: models.id }).from(models).where(inArray(models.interface_id, removed.map(endpoint => endpoint.id))).limit(1)).length) {
    throw new ProviderWriteError('An interface is still selected by a model', 409)
  }
  const version = (await ctx.modelCatalog.status()).version
  const index = (await catalogForModels(ctx, null, [], version)).providers
  const association = input.models_dev_provider
  if (association?.source === 'manual' && !index[association.provider_id] && association.provider_id !== before?.models_dev_provider_id) {
    throw new ProviderWriteError('Unknown catalog provider')
  }
  const endpointInputs = input.interfaces.map((endpoint, ordinal) => ({ ...endpoint, id: ordinal }))
  const match = matchProviderByEndpoints({
    interfaces: endpointInputs,
    defaultInterfaceId: endpointInputs.find(endpoint => endpoint.protocol === input.default_protocol)!.id,
    modelsDevProviderSource: association?.source ?? before?.models_dev_provider_source,
    modelsDevProviderId: association?.source === 'manual' ? association.provider_id : before?.models_dev_provider_id,
  }, index)
  const previousKey = input.api_key !== undefined && before?.api_key ? await decryptSecret(ctx.env.KEY_ENCRYPTION_SECRET, before.api_key) : null
  const requestedKey = input.api_key === undefined ? previousKey : input.api_key || null
  const keyChanged = requestedKey !== previousKey
  const encryptedKey = keyChanged && requestedKey ? await encryptSecret(ctx.env.KEY_ENCRYPTION_SECRET, requestedKey) : keyChanged ? null : before?.api_key ?? null
  const now = Date.now()
  const fields = {
    name: input.name, ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    models_dev_provider_id: match.id, models_dev_provider_source: match.source,
  }
  const operations: BatchItem<'sqlite'>[] = []
  const rows = before && before.models_dev_provider_id !== match.id
    ? await db.select(modelSourceColumns).from(models).where(eq(models.provider_id, before.id)) : undefined
  if (before) operations.push(providerSourceFence(db, before, version, rows))
  // MAX(id) refers to the just-inserted AUTOINCREMENT row inside this single atomic D1 batch.
  // Never split creation and interface/default writes into separate batches.
  const providerId = id ?? sql<number>`(SELECT MAX(id) FROM providers)`
  if (before) operations.push(db.update(providers).set({
    ...fields,
    ...(input.api_key === undefined ? {} : {
      api_key: encryptedKey,
      // A stale credential edit must abort the whole batch. Never reuse a version for another key.
      credential_version: sql`CASE WHEN ${providers.credential_version} = ${credentialExpectation!.credential_version} AND ${providers.api_key} IS ${credentialExpectation!.api_key} THEN ${providers.credential_version} + ${Number(keyChanged)} ELSE NULL END`,
    }),
  }).where(eq(providers.id, before.id)))
  else operations.push(db.insert(providers).values({
    ...fields, enabled: input.enabled ?? true, api_key: encryptedKey, credential_version: 1, user_id: DEFAULT_USER_ID, created_at: now,
  }))
  operations.push(db.delete(providerInterfaces).where(and(eq(providerInterfaces.provider_id, providerId), notInArray(providerInterfaces.protocol, protocols))))
  for (const endpoint of input.interfaces) {
    operations.push(db.insert(providerInterfaces).values({
      provider_id: providerId, protocol: endpoint.protocol, base_url: endpoint.base_url,
      native_files: endpoint.native_files ?? false, created_at: now,
    }).onConflictDoUpdate({
      target: [providerInterfaces.provider_id, providerInterfaces.protocol],
      set: { base_url: endpoint.base_url, native_files: endpoint.native_files ?? false },
    }))
  }
  operations.push(db.update(providers).set({
    default_interface_id: sql`(SELECT id FROM provider_interfaces WHERE provider_id = ${providerId} AND protocol = ${input.default_protocol})`,
  }).where(eq(providers.id, providerId)))
  if (before && rows) {
    operations.push(...materializationUpdates(db, rows, await catalogForModels(ctx, match.id, rows.map(model => model.model_id), version), {
      id: before.id, models_dev_provider_id: match.id, models_dev_provider_source: match.source,
    }))
  }
  if (before) {
    await normalizeProviderFileScopes(ctx, before)
    const invalidated = invalidatedProviderFiles(before, input.interfaces, keyChanged)
    await cleanupProviderFilesBeforeChange(ctx, before, existing, invalidated)
    // Prune invalidated pointers in the same transaction as the new configuration, including
    // uploads that completed during remote cleanup. Never store the previous credentials.
    operations.push(db.delete(attachmentProviderFiles).where(invalidated))
  }
  operations.push(db.select().from(providers).where(eq(providers.id, providerId)))
  operations.push(db.select().from(providerInterfaces).where(eq(providerInterfaces.provider_id, providerId)).orderBy(providerInterfaces.id))
  const results = await db.batch(operations as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]).catch((error: unknown) => {
    if (isModelSourceConflict(error)) throw new ModelSourceConflict()
    let cause = error
    while (cause instanceof Error) {
      if (cause.message.includes('NOT NULL constraint failed: providers.credential_version')) {
        throw new ProviderWriteError('Credentials changed concurrently; reload and retry', 409)
      }
      cause = cause.cause
    }
    // Database errors can embed bound ciphertext in their query text; never return them over REST.
    throw new Error('Provider write failed')
  })
  const row = (results[results.length - 2] as ProviderRow[])[0]!
  const interfaces = results[results.length - 1] as ProviderInterfaceRow[]
  return { provider: toProviderDto(row, interfaces), warning: match.warning }
}
