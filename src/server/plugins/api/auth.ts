import type { Context } from 'cordis'
import type { Context as HonoContext } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { AuthSession } from '../auth'
import { parseAuthUserId } from '../auth/user-id'

export type ApiEnv = { Bindings: Env; Variables: { authSession: AuthSession } }

export const requireAuth = (ctx: Context) => createMiddleware<ApiEnv>(async (c, next) => {
  const authSession = await ctx.auth.instance.api.getSession({ headers: c.req.raw.headers })
  if (!authSession || authSession.user.banned) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authSession', authSession)
  await next()
})

export function authUserId(c: HonoContext<ApiEnv>): number {
  return parseAuthUserId(c.get('authSession').user.id)
}

export const requireAdmin = (ctx: Context) => createMiddleware<ApiEnv>(async (c, next) => {
  const permission = await ctx.auth.instance.api.userHasPermission({
    headers: c.req.raw.headers,
    body: { permissions: { user: ['list'] } },
  })
  if (!permission.success) return c.json({ error: 'Forbidden' }, 403)
  await next()
})
