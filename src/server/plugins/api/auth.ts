import type { Context } from 'cordis'
import type { Context as HonoContext } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { AuthSession } from '../auth'
import { parseAuthUserId } from '../auth/user-id'
import { isAuthOwner } from '@/shared/auth'

export type ApiEnv = { Bindings: Env; Variables: { authSession: AuthSession } }

export const requireAuth = (ctx: Context) => createMiddleware<ApiEnv>(async (c, next) => {
  const authSession = await ctx.auth.instance.api.getSession({ headers: c.req.raw.headers })
  // A refusal must not outlive its reason in someone's cache. 401 is not cacheable by default and
  // 404 is, so the rule is stated here rather than left to each status code's defaults.
  if (!authSession || authSession.user.banned) return c.json({ error: 'Unauthorized' }, 401, { 'cache-control': 'no-store' })
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

/** Owner-only, unlike `requireAdmin`: an ordinary administrator is refused too. Runs after `requireAuth`. */
export const requireOwner = createMiddleware<ApiEnv>(async (c, next) => {
  if (!isAuthOwner(c.get('authSession').user)) return c.json({ error: 'Forbidden' }, 403)
  await next()
})
