import type { Context } from 'cordis'
import { Hono } from 'hono'
import { authUserId, type ApiEnv } from './auth'
import { getUser } from '../hub/conversations'
import { PRESET_PROVIDERS } from '../llm/presets'

export function meRoutes(ctx: Context) {
  const r = new Hono<ApiEnv>()
  r.get('/me', async (c) => {
    const userId = authUserId(c)
    const identity = c.get('authSession').user
    const user = await getUser(ctx.db.orm, userId)
    return user ? c.json({ id: userId, name: identity.name, email: identity.email, role: identity.role, settings: user.settings, created_at: user.createdAt.getTime() }) : c.json({ error: 'no user' }, 500)
  })
  r.get('/presets', (c) => c.json(PRESET_PROVIDERS))
  return r
}
