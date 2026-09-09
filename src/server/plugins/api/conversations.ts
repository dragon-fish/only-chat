import type { Context } from 'cordis'
import { Hono } from 'hono'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { getConversation, listMessages, listConversations, toMessage } from '../hub/conversations'
import { parseId } from './params'

export function conversationRoutes(ctx: Context) {
  const r = new Hono<{ Bindings: Env }>()
  r.get('/conversations', async (c) => c.json(await listConversations(ctx.db.orm, DEFAULT_USER_ID)))
  r.get('/conversations/:id/messages', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'not found' }, 404)
    const s = await getConversation(ctx.db.orm, id)
    if (!s || s.user_id !== DEFAULT_USER_ID) return c.json({ error: 'not found' }, 404)
    const rows = await listMessages(ctx.db.orm, id)
    return c.json(rows.map((row) => toMessage(row)))
  })
  return r
}
