import type { Context } from 'cordis'
import { Hono, type Context as HonoContext } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { authUserId, type ApiEnv } from './auth'
import { BulkModelStateInputSchema, ModelWriteInputSchema } from '@/shared/api'
import { ModelQuerySchema } from '@/shared/models'
import { models, providerInterfaces, providers } from '../../db/schema'
import { parseId } from './params'
import { ModelQueryError, queryModels } from './model-query'
import { catalogForModels, changedModelFields, ModelSourceConflict, modelSourceColumns, modelSourceFence, modelSourceMatches, providerSourceFence, resolveModelFields, retryModelSource, toModelDto } from './model-write'

export function modelRoutes(ctx: Context) {
  const r = new Hono<ApiEnv>()
  const db = ctx.db.orm
  const ownedProvider = (id: number, userId: number) => db.query.providers.findFirst({ where: and(eq(providers.id, id), eq(providers.user_id, userId)) })
  const ownsInterface = async (pid: number, iid: number | null | undefined) => iid == null || !!await db.query.providerInterfaces.findFirst({
    where: and(eq(providerInterfaces.id, iid), eq(providerInterfaces.provider_id, pid)),
  })

  r.get('/providers/:id/models/by-ref', async c => {
    const userId = authUserId(c)
    const pid = parseId(c.req.param('id'))
    if (pid === null || !await ownedProvider(pid, userId)) return c.json({ error: 'not found' }, 404)
    const row = await db.query.models.findFirst({ where: and(eq(models.provider_id, pid), eq(models.model_id, c.req.query('model_id') ?? '')) })
    return row ? c.json(toModelDto(row)) : c.json({ error: 'not found' }, 404)
  })

  async function modelPage(c: HonoContext<ApiEnv>, userId: number, providerId?: number) {
    const raw: Record<string, unknown> = { ...c.req.query(), ...(providerId === undefined ? {} : { provider_id: providerId }) }
    for (const name of ['provider_id', 'interface_id', 'min_context', 'limit']) if (raw[name] !== undefined) raw[name] = Number(raw[name])
    for (const name of ['enabled', 'vision', 'reasoning', 'tools', 'image_output']) {
      if (raw[name] === 'true') raw[name] = true
      else if (raw[name] === 'false') raw[name] = false
    }
    const parsed = ModelQuerySchema.safeParse(raw)
    if (!parsed.success) return c.json({ error: 'invalid query', issues: parsed.error.issues }, 400)
    try { return c.json(await queryModels(ctx.env.DB, parsed.data, userId)) }
    catch (error) {
      if (error instanceof ModelQueryError) return c.json({ error: error.message }, 400)
      throw error
    }
  }

  r.get('/models', c => modelPage(c, authUserId(c)))

  r.get('/providers/:id/models', async c => {
    const userId = authUserId(c)
    const pid = parseId(c.req.param('id'))
    if (pid === null || !await ownedProvider(pid, userId)) return c.json({ error: 'not found' }, 404)
    return modelPage(c, userId, pid)
  })

  r.post('/providers/:id/models', async c => {
    const userId = authUserId(c)
    const pid = parseId(c.req.param('id'))
    const provider = pid === null ? undefined : await ownedProvider(pid, userId)
    if (!provider) return c.json({ error: 'not found' }, 404)
    const parsed = ModelWriteInputSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    const input = parsed.data
    if (!await ownsInterface(provider.id, input.interface_id)) return c.json({ error: 'Interface must belong to this provider' }, 400)
    try {
      return await retryModelSource(async () => {
        const currentProvider = await ownedProvider(provider.id, userId)
        if (!currentProvider) return c.json({ error: 'not found' }, 404)
        const override = input.metadata_override ?? {}
        const catalog = await catalogForModels(ctx, currentProvider.models_dev_provider_id, [input.model_id])
        const existing = await db.select(modelSourceColumns).from(models).where(and(eq(models.provider_id, provider.id), eq(models.model_id, input.model_id))).get()
        if (existing) {
          const [, , rows] = await db.batch([
            providerSourceFence(db, currentProvider, catalog.version),
            modelSourceFence(db, existing, currentProvider, catalog.version),
            db.update(models).set({ manual_pinned: true }).where(modelSourceMatches(existing, currentProvider, catalog.version)).returning(),
          ])
          const row = rows[0]
          return row ? c.json(toModelDto(row)) : c.json({ error: 'not found' }, 404)
        }
        const [, rows] = await db.batch([
          providerSourceFence(db, currentProvider, catalog.version),
          db.insert(models).values({
            ...input, provider_id: provider.id, metadata_override: override, manual_pinned: true, upstream_available: null,
            ...resolveModelFields(catalog, currentProvider.models_dev_provider_id, input.model_id, override),
          }).onConflictDoNothing().returning(),
        ])
        const row = rows[0]
        return row ? c.json(toModelDto(row), 201) : c.json({ error: 'model already exists' }, 409)
      })
    } catch (error) {
      if (error instanceof ModelSourceConflict) return c.json({ error: error.message }, 409)
      throw error
    }
  })

  r.put('/providers/:id/models/bulk', async c => {
    const userId = authUserId(c)
    const pid = parseId(c.req.param('id'))
    const provider = pid === null ? undefined : await ownedProvider(pid, userId)
    if (!provider) return c.json({ error: 'not found' }, 404)
    const parsed = BulkModelStateInputSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    try {
      return await retryModelSource(async () => {
        const currentProvider = await ownedProvider(provider.id, userId)
        if (!currentProvider) return c.json({ error: 'not found' }, 404)
        const condition = and(eq(models.provider_id, provider.id), parsed.data.lab_id === undefined
          ? undefined
          : parsed.data.lab_id === null ? isNull(models.lab_id) : eq(models.lab_id, parsed.data.lab_id))
        const rows = await db.select(modelSourceColumns).from(models).where(condition)
        const version = (await ctx.modelCatalog.status()).version
        const operations: BatchItem<'sqlite'>[] = [providerSourceFence(db, currentProvider, version)]
        let updated = 0
        let deleted = 0
        for (const row of rows) {
          operations.push(modelSourceFence(db, row, currentProvider, version))
          if (!parsed.data.enabled && row.upstream_available === false && !row.manual_pinned) {
            deleted++
            operations.push(db.delete(models).where(modelSourceMatches(row, currentProvider, version)))
          } else if (row.enabled !== parsed.data.enabled) {
            updated++
            operations.push(db.update(models).set({ enabled: parsed.data.enabled }).where(modelSourceMatches(row, currentProvider, version)))
          }
        }
        await db.batch(operations as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
        return c.json({ updated, deleted })
      })
    } catch (error) {
      if (error instanceof ModelSourceConflict) return c.json({ error: error.message }, 409)
      throw error
    }
  })

  r.put('/providers/:id/models/:modelRowId', async c => {
    const userId = authUserId(c)
    const pid = parseId(c.req.param('id'))
    const mid = parseId(c.req.param('modelRowId'))
    const provider = pid === null ? undefined : await ownedProvider(pid, userId)
    if (!provider || mid === null) return c.json({ error: 'not found' }, 404)
    const parsed = ModelWriteInputSchema.partial().safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    const input = parsed.data
    if (!await ownsInterface(provider.id, input.interface_id)) return c.json({ error: 'Interface must belong to this provider' }, 400)
    try {
      return await retryModelSource(async () => {
        const currentProvider = await ownedProvider(provider.id, userId)
        if (!currentProvider) return c.json({ error: 'not found' }, 404)
        const before = await db.select(modelSourceColumns).from(models).where(and(eq(models.id, mid), eq(models.provider_id, provider.id))).get()
        if (!before) return c.json({ error: 'not found' }, 404)
        const modelId = input.model_id ?? before.model_id
        const conflict = await db.query.models.findFirst({ where: and(eq(models.provider_id, provider.id), eq(models.model_id, modelId)) })
        if (conflict && conflict.id !== mid) return c.json({ error: 'model already exists' }, 409)
        const catalog = await catalogForModels(ctx, currentProvider.models_dev_provider_id, [modelId])
        const changed = changedModelFields(before, {
          ...input, ...resolveModelFields(catalog, currentProvider.models_dev_provider_id, modelId, input.metadata_override ?? before.metadata_override),
        })
        const condition = modelSourceMatches(before, currentProvider, catalog.version)
        const [, , rows] = await db.batch([
          providerSourceFence(db, currentProvider, catalog.version),
          modelSourceFence(db, before, currentProvider, catalog.version),
          Object.keys(changed).length ? db.update(models).set(changed).where(condition).returning() : db.select().from(models).where(condition),
        ])
        const row = rows[0]
        return row ? c.json(toModelDto(row)) : c.json({ error: 'not found' }, 404)
      })
    } catch (error) {
      if (error instanceof ModelSourceConflict) return c.json({ error: error.message }, 409)
      throw error
    }
  })

  r.delete('/providers/:id/models/:modelRowId', async c => {
    const userId = authUserId(c)
    const pid = parseId(c.req.param('id'))
    const mid = parseId(c.req.param('modelRowId'))
    if (pid === null || mid === null || !await ownedProvider(pid, userId)) return c.json({ error: 'not found' }, 404)
    const rows = await db.delete(models).where(and(eq(models.id, mid), eq(models.provider_id, pid))).returning({ id: models.id })
    return rows.length ? c.body(null, 204) : c.json({ error: 'not found' }, 404)
  })
  return r
}
