import type { Context } from 'cordis'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { siteSettings } from '@/server/db/schema'
import { AdminSiteSettingsUpdateSchema, isAuthOwner, type SiteConfig } from '@/shared/auth'
import { resolveAllowRegister } from '../auth/site-settings'
import { isAuditEnabled } from './audit'
import { requireAdmin, type ApiEnv } from './auth'

/**
 * Everything site-wide the client needs, in one request: it runs before the session guard, so a
 * guest reads it too. Fields that concern only the owner are added when the session is the owner's.
 */
export function publicSiteConfigRoutes(ctx: Context) {
  const r = new Hono<ApiEnv>()
  r.get('/site-config', async c => {
    const [setting, session] = await Promise.all([
      resolveAllowRegister(ctx.db.orm, ctx.env.ALLOW_REGISTER),
      ctx.auth.instance.api.getSession({ headers: c.req.raw.headers }),
    ])
    const config: SiteConfig = { allowRegister: setting.value }
    if (session && !session.user.banned && isAuthOwner(session.user)) config.audit = isAuditEnabled(ctx.env.ENABLE_AUDIT)
    // The body depends on who asks.
    return c.json(config, 200, { 'cache-control': 'private, no-store' })
  })
  return r
}

export function adminSiteSettingsRoutes(ctx: Context) {
  const r = new Hono<ApiEnv>()
  r.use('/admin/*', requireAdmin(ctx))
  r.get('/admin/settings', async c => {
    const setting = await resolveAllowRegister(ctx.db.orm, ctx.env.ALLOW_REGISTER)
    return c.json({ allowRegister: setting.value, source: setting.source })
  })
  r.put('/admin/settings', async c => {
    const body = AdminSiteSettingsUpdateSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'Invalid site settings' }, 400)
    if (body.data.allowRegister === null) {
      await ctx.db.orm.delete(siteSettings).where(eq(siteSettings.key, 'auth.allow_register'))
      const setting = await resolveAllowRegister(ctx.db.orm, ctx.env.ALLOW_REGISTER)
      return c.json({ allowRegister: setting.value, source: setting.source })
    }
    const value = String(body.data.allowRegister)
    const updatedAt = new Date()
    await ctx.db.orm.insert(siteSettings).values({ key: 'auth.allow_register', value, updatedAt })
      .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt } })
    return c.json({ allowRegister: body.data.allowRegister, source: 'db' as const })
  })
  return r
}
