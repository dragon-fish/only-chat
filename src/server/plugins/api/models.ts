import type { Context } from 'cordis'
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { ModelWriteInputSchema } from '@/shared/api'
import { ModelQuerySchema } from '@/shared/models'
import { models, providerInterfaces, providers } from '../../db/schema'
import { parseId } from './params'
import { ModelQueryError, queryModels } from './model-query'
import { catalogForModels, changedModelFields, resolveModelFields, toModelDto } from './model-write'

export function modelRoutes(ctx: Context) {
  const r = new Hono<{ Bindings: Env }>()
  const db = ctx.db.orm
  const ownedProvider = (id: number) => db.query.providers.findFirst({ where: and(eq(providers.id, id), eq(providers.user_id, DEFAULT_USER_ID)) })
  const ownsInterface = async (pid: number, iid: number | null | undefined) => iid == null || !!await db.query.providerInterfaces.findFirst({
    where: and(eq(providerInterfaces.id, iid), eq(providerInterfaces.provider_id, pid)),
  })

  r.get('/providers/:id/models/by-ref', async c => {
    const pid = parseId(c.req.param('id'))
    if (pid === null || !await ownedProvider(pid)) return c.json({ error: 'not found' }, 404)
    const row = await db.query.models.findFirst({ where: and(eq(models.provider_id, pid), eq(models.model_id, c.req.query('model_id') ?? '')) })
    return row ? c.json(toModelDto(row)) : c.json({ error: 'not found' }, 404)
  })

  r.get('/models', async c => {
    const raw: Record<string, unknown> = { ...c.req.query() }
    for (const name of ['provider_id', 'interface_id', 'min_context', 'limit']) if (raw[name] !== undefined) raw[name] = Number(raw[name])
    for (const name of ['enabled', 'vision', 'reasoning', 'tools', 'image_output']) {
      if (raw[name] === 'true') raw[name] = true
      else if (raw[name] === 'false') raw[name] = false
    }
    const parsed = ModelQuerySchema.safeParse(raw)
    if (!parsed.success) return c.json({ error: 'invalid query', issues: parsed.error.issues }, 400)
    try { return c.json(await queryModels(ctx.env.DB, parsed.data)) }
    catch (error) {
      if (error instanceof ModelQueryError) return c.json({ error: error.message }, 400)
      throw error
    }
  })

  r.get('/providers/:id/models', async c => {
    const pid = parseId(c.req.param('id'))
    if (pid === null || !await ownedProvider(pid)) return c.json({ error: 'not found' }, 404)
    const url = new URL(c.req.url)
    url.pathname = '/models'
    url.searchParams.set('provider_id', String(pid))
    return r.request(url)
  })

  r.post('/providers/:id/models', async c => {
    const pid = parseId(c.req.param('id'))
    const provider = pid === null ? undefined : await ownedProvider(pid)
    if (!provider) return c.json({ error: 'not found' }, 404)
    const parsed = ModelWriteInputSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    const input = parsed.data
    if (!await ownsInterface(provider.id, input.interface_id)) return c.json({ error: 'Interface must belong to this provider' }, 400)
    const override = input.metadata_override ?? {}
    const catalog = await catalogForModels(ctx, provider.models_dev_provider_id, [input.model_id])
    const [row] = await db.insert(models).values({
      ...input, provider_id: provider.id, display_name: input.model_id, capabilities: {}, metadata_override: override,
      ...resolveModelFields(catalog, provider.models_dev_provider_id, input.model_id, override),
    }).onConflictDoNothing().returning()
    return row ? c.json(toModelDto(row), 201) : c.json({ error: 'model already exists' }, 409)
  })

  r.put('/providers/:id/models/:modelRowId', async c => {
    const pid = parseId(c.req.param('id'))
    const mid = parseId(c.req.param('modelRowId'))
    const provider = pid === null ? undefined : await ownedProvider(pid)
    if (!provider || mid === null) return c.json({ error: 'not found' }, 404)
    const parsed = ModelWriteInputSchema.partial().safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    const input = parsed.data
    if (!await ownsInterface(provider.id, input.interface_id)) return c.json({ error: 'Interface must belong to this provider' }, 400)
    const before = await db.query.models.findFirst({ where: and(eq(models.id, mid), eq(models.provider_id, provider.id)) })
    if (!before) return c.json({ error: 'not found' }, 404)
    const modelId = input.model_id ?? before.model_id
    const conflict = await db.query.models.findFirst({ where: and(eq(models.provider_id, provider.id), eq(models.model_id, modelId)) })
    if (conflict && conflict.id !== mid) return c.json({ error: 'model already exists' }, 409)
    const catalog = await catalogForModels(ctx, provider.models_dev_provider_id, [modelId])
    const changed = changedModelFields(before, {
      ...input, ...resolveModelFields(catalog, provider.models_dev_provider_id, modelId, input.metadata_override ?? before.metadata_override),
    })
    if (!Object.keys(changed).length) return c.json(toModelDto(before))
    const [row] = await db.update(models).set(changed).where(and(eq(models.id, mid), eq(models.provider_id, provider.id))).returning()
    return row ? c.json(toModelDto(row)) : c.json({ error: 'not found' }, 404)
  })

  r.delete('/providers/:id/models/:modelRowId', async c => {
    const pid = parseId(c.req.param('id'))
    const mid = parseId(c.req.param('modelRowId'))
    if (pid === null || mid === null || !await ownedProvider(pid)) return c.json({ error: 'not found' }, 404)
    await db.delete(models).where(and(eq(models.id, mid), eq(models.provider_id, pid)))
    return c.body(null, 204)
  })
  return r
}
