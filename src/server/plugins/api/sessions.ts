import type { Context } from 'cordis'
import { Hono } from 'hono'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { getSession, listMessages, listSessions, toMessage } from '../hub/sessions'

export function sessionRoutes(ctx: Context) {
  const r = new Hono<{ Bindings: Env }>()
  r.get('/sessions', async (c) => c.json(await listSessions(ctx.db.orm, DEFAULT_USER_ID)))
  r.get('/sessions/:id/messages', async (c) => {
    const id = Number(c.req.param('id'))
    const s = await getSession(ctx.db.orm, id)
    if (!s || s.user_id !== DEFAULT_USER_ID) return c.json({ error: 'not found' }, 404)
    const rows = await listMessages(ctx.db.orm, id)
    return c.json(rows.map((row) => toMessage(row)))
  })
  return r
}
