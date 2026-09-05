import type { Context } from 'cordis'
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { ModelInputSchema } from '@/shared/api'
import { models, providers } from '../../db/schema'
import { parseId } from './params'

export function modelRoutes(ctx: Context) {
  const r = new Hono<{ Bindings: Env }>()
  const db = ctx.db.orm

  async function ownsProvider(id: number): Promise<boolean> {
    const p = await db.query.providers.findFirst({ where: and(eq(providers.id, id), eq(providers.user_id, DEFAULT_USER_ID)) })
    return p !== undefined
  }

  r.get('/providers/:id/models', async (c) => {
    const pid = parseId(c.req.param('id'))
    if (pid === null || !(await ownsProvider(pid))) return c.json({ error: 'not found' }, 404)
    return c.json(await db.select().from(models).where(eq(models.provider_id, pid)).orderBy(models.sort, models.id))
  })

  r.post('/providers/:id/models', async (c) => {
    const pid = parseId(c.req.param('id'))
    if (pid === null || !(await ownsProvider(pid))) return c.json({ error: 'not found' }, 404)
    const parsed = ModelInputSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    const i = parsed.data
    // Manual add is a plain insert (spec §6): a duplicate (provider_id, model_id) is a 409, never
    // an overwrite, so a user's edited enabled/sort/pricing on the existing row is never clobbered.
    const existing = await db.query.models.findFirst({ where: and(eq(models.provider_id, pid), eq(models.model_id, i.model_id)) })
    if (existing) return c.json({ error: 'model already exists' }, 409)
    const [row] = await db.insert(models).values({
      provider_id: pid, model_id: i.model_id, display_name: i.display_name ?? i.model_id,
      capabilities: i.capabilities ?? {}, pricing: i.pricing ?? null, enabled: i.enabled ?? true, sort: i.sort ?? 0,
    }).returning()
    return c.json(row, 201)
  })

  r.put('/providers/:id/models/:modelRowId', async (c) => {
    const pid = parseId(c.req.param('id'))
    const mid = parseId(c.req.param('modelRowId'))
    if (pid === null || mid === null || !(await ownsProvider(pid))) return c.json({ error: 'not found' }, 404)
    const parsed = ModelInputSchema.partial().safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    const [row] = await db.update(models).set(parsed.data).where(and(eq(models.id, mid), eq(models.provider_id, pid))).returning()
    return row ? c.json(row) : c.json({ error: 'not found' }, 404)
  })

  r.delete('/providers/:id/models/:modelRowId', async (c) => {
    const pid = parseId(c.req.param('id'))
    const mid = parseId(c.req.param('modelRowId'))
    if (pid === null || mid === null || !(await ownsProvider(pid))) return c.json({ error: 'not found' }, 404)
    await db.delete(models).where(and(eq(models.id, mid), eq(models.provider_id, pid)))
    return c.body(null, 204)
  })

  return r
}
