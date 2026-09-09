import type { Context } from 'cordis'
import { Hono } from 'hono'
import { authUserId, type ApiEnv } from './auth'
import { getConversation, listMessages, listConversations, toMessage } from '../hub/conversations'
import { parseId } from './params'

export function conversationRoutes(ctx: Context) {
  const r = new Hono<ApiEnv>()
  r.get('/conversations', async (c) => c.json(await listConversations(ctx.db.orm, authUserId(c))))
  r.get('/conversations/:id/messages', async (c) => {
    const userId = authUserId(c)
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'not found' }, 404)
    const s = await getConversation(ctx.db.orm, id, userId)
    if (!s) return c.json({ error: 'not found' }, 404)
    const rows = await listMessages(ctx.db.orm, id, userId)
    return c.json(rows.map((row) => toMessage(row)))
  })
  return r
}
