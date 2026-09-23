import type { Context } from 'cordis'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { DB } from '@/server/db/client'
import { models, providers, users, type ModelRow } from '@/server/db/schema'
import { ModelListSnapshotSchema, type ModelListItem, type ModelListSnapshot } from '@/shared/models'

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60
const CACHE_WARNING_BYTES = 20 * 1024 * 1024
const CACHE_SCHEMA_VERSION = 1
const pendingFills = new Map<string, Promise<ModelListSnapshot>>()

export function bumpModelListRevisions(db: DB, userId: number, providerId: number) {
  return [
    db.update(providers).set({ model_revision: sql`${providers.model_revision} + 1` })
      .where(and(eq(providers.id, providerId), eq(providers.user_id, userId))),
    db.update(users).set({ enabled_models_revision: sql`${users.enabled_models_revision} + 1` })
      .where(eq(users.id, userId)),
  ] as const
}

function listMetadata(metadata: ModelRow['metadata_resolved']): ModelListItem['metadata'] {
  const { name, family, reasoning, reasoning_options, tool_call, modalities, limit, interleaved } = metadata
  return Object.fromEntries(Object.entries({ name, family, reasoning, reasoning_options, tool_call, modalities, limit, interleaved })
    .filter(([, value]) => value !== undefined)) as ModelListItem['metadata']
}

export function toModelListItem(row: ModelRow): ModelListItem {
  return {
    id: row.id,
    provider_id: row.provider_id,
    model_id: row.model_id,
    interface_id: row.interface_id,
    metadata: listMetadata(row.metadata_resolved),
    image_extra_body: row.image_extra_body,
    lab_id: row.lab_id,
    enabled: row.enabled,
    manual_pinned: row.manual_pinned,
    upstream_available: row.upstream_available,
    sort: row.sort,
  }
}

async function cached(ctx: Context, key: string, build: () => Promise<ModelListSnapshot>): Promise<ModelListSnapshot> {
  try {
    const value = await ctx.env.KV.get(key, 'json')
    const parsed = ModelListSnapshotSchema.safeParse(value)
    if (parsed.success) return parsed.data
  } catch (error) {
    console.warn('Model list KV read failed', { key, error })
  }
  const existing = pendingFills.get(key)
  if (existing) return existing
  const operation = (async () => {
    const value = await build()
    const serialized = JSON.stringify(value)
    const bytes = new TextEncoder().encode(serialized).byteLength
    if (bytes >= CACHE_WARNING_BYTES) console.warn('Model list KV value is approaching the platform limit', { key, bytes })
    try {
      await ctx.env.KV.put(key, serialized, { expirationTtl: CACHE_TTL_SECONDS })
    } catch (error) {
      console.warn('Model list KV write failed', { key, error })
    }
    return value
  })().finally(() => { if (pendingFills.get(key) === operation) pendingFills.delete(key) })
  pendingFills.set(key, operation)
  return operation
}

async function catalogVersion(ctx: Context): Promise<string> {
  return (await ctx.modelCatalog.status()).version ?? 'none'
}

export async function providerModelList(ctx: Context, userId: number, providerId: number): Promise<ModelListSnapshot | null> {
  const provider = await ctx.db.orm.query.providers.findFirst({
    where: and(eq(providers.id, providerId), eq(providers.user_id, userId)),
  })
  if (!provider) return null
  if (!Number.isInteger(provider.model_revision)) throw new Error('Model list cache schema is unavailable')
  const version = await catalogVersion(ctx)
  const key = `model-list:v${CACHE_SCHEMA_VERSION}:user:${userId}:provider:${providerId}:r${provider.model_revision}:c${version}`
  return cached(ctx, key, async () => ({
    models: (await ctx.db.orm.select().from(models).where(eq(models.provider_id, providerId))
      .orderBy(asc(models.sort), asc(models.id))).map(toModelListItem),
  }))
}

export async function enabledModelList(ctx: Context, userId: number): Promise<ModelListSnapshot> {
  const user = await ctx.db.orm.query.users.findFirst({ where: eq(users.id, userId) })
  if (!user) return { models: [] }
  if (!Number.isInteger(user.enabled_models_revision)) throw new Error('Model list cache schema is unavailable')
  const version = await catalogVersion(ctx)
  const key = `model-list:v${CACHE_SCHEMA_VERSION}:user:${userId}:enabled:r${user.enabled_models_revision}:c${version}`
  return cached(ctx, key, async () => {
    const rows = await ctx.db.orm.select({ model: models }).from(models)
      .innerJoin(providers, eq(providers.id, models.provider_id))
      .where(and(eq(providers.user_id, userId), eq(providers.enabled, true), eq(models.enabled, true)))
      .orderBy(asc(providers.id), asc(models.sort), asc(models.id))
    return { models: rows.map(row => toModelListItem(row.model)) }
  })
}
