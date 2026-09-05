import type { Context } from 'cordis'
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { ProviderInputSchema } from '@/shared/api'
import type { Provider } from '@/shared/models'
import { models, providers, type ProviderRow } from '../../db/schema'
import { decryptSecret, encryptSecret } from '../llm/crypto'
import { listRemoteModels } from '../llm/list-models'

export function toProviderDto(row: ProviderRow): Provider {
  const { api_key, ...rest } = row
  return { ...rest, has_key: api_key !== null }
}

export function providerRoutes(ctx: Context) {
  const r = new Hono<{ Bindings: Env }>()
  const db = ctx.db.orm
  const secret = ctx.env.KEY_ENCRYPTION_SECRET
  const owned = (id: number) => and(eq(providers.id, id), eq(providers.user_id, DEFAULT_USER_ID))

  r.get('/providers', async (c) => {
    const rows = await db.select().from(providers).where(eq(providers.user_id, DEFAULT_USER_ID)).orderBy(providers.id)
    return c.json(rows.map(toProviderDto))
  })

  r.post('/providers', async (c) => {
    const parsed = ProviderInputSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    const { api_key, ...input } = parsed.data
    const [row] = await db.insert(providers).values({
      user_id: DEFAULT_USER_ID, name: input.name, protocol: input.protocol, base_url: input.base_url,
      api_key: api_key ? await encryptSecret(secret, api_key) : null,
      extra: input.extra ?? null, enabled: input.enabled ?? true, created_at: Date.now(),
    }).returning()
    return c.json(toProviderDto(row!), 201)
  })

  r.put('/providers/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const parsed = ProviderInputSchema.partial().safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    const { api_key, ...patch } = parsed.data
    const set: Partial<ProviderRow> = { ...patch }
    if (api_key !== undefined) set.api_key = api_key === '' ? null : await encryptSecret(secret, api_key)
    const [row] = await db.update(providers).set(set).where(owned(id)).returning()
    return row ? c.json(toProviderDto(row)) : c.json({ error: 'not found' }, 404)
  })

  r.delete('/providers/:id', async (c) => {
    const id = Number(c.req.param('id'))
    await db.delete(providers).where(owned(id))
    return c.body(null, 204)
  })

  r.post('/providers/:id/fetch-models', async (c) => {
    const id = Number(c.req.param('id'))
    const row = await db.query.providers.findFirst({ where: owned(id) })
    if (!row) return c.json({ error: 'not found' }, 404)
    const key = row.api_key ? await decryptSecret(secret, row.api_key) : null
    const ids = await listRemoteModels(row, key)
    let imported = 0
    for (const model_id of ids) {
      const res = await db.insert(models)
        .values({ provider_id: id, model_id, display_name: model_id, capabilities: {}, pricing: null, enabled: true, sort: 0 })
        .onConflictDoNothing().returning({ id: models.id })
      if (res.length > 0) imported++
    }
    return c.json({ imported, models: ids })
  })

  return r
}
