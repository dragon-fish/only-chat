import type { Context } from 'cordis'
import { Hono } from 'hono'
import { siteSettings } from '@/server/db/schema'
import { PublicSiteSettingsSchema } from '@/shared/auth'
import { resolveAllowRegister } from '../auth/site-settings'
import { requireAdmin, type ApiEnv } from './auth'

export function publicSiteSettingsRoutes(ctx: Context) {
  const r = new Hono<ApiEnv>()
  r.get('/site-settings', async c => {
    const setting = await resolveAllowRegister(ctx.db.orm, ctx.env.ALLOW_REGISTER)
    return c.json({ allowRegister: setting.value })
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
    const body = PublicSiteSettingsSchema.strict().safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'Invalid site settings' }, 400)
    const value = String(body.data.allowRegister)
    const updatedAt = new Date()
    await ctx.db.orm.insert(siteSettings).values({ key: 'auth.allow_register', value, updatedAt })
      .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt } })
    return c.json({ allowRegister: body.data.allowRegister, source: 'db' as const })
  })
  return r
}
