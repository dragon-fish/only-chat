import type { Context } from 'cordis'
import { Hono } from 'hono'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { getUser } from '../hub/conversations'
import { PRESET_PROVIDERS } from '../llm/presets'

export function meRoutes(ctx: Context) {
  const r = new Hono<{ Bindings: Env }>()
  r.get('/me', async (c) => {
    const user = await getUser(ctx.db.orm, DEFAULT_USER_ID)
    return user ? c.json(user) : c.json({ error: 'no user' }, 500)
  })
  r.get('/presets', (c) => c.json(PRESET_PROVIDERS))
  return r
}
