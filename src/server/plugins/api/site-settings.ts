import type { Context } from 'cordis'
import { Hono } from 'hono'
import type { BatchItem } from 'drizzle-orm/batch'
import { eq } from 'drizzle-orm'
import { siteSettings } from '@/server/db/schema'
import { AdminSiteSettingsUpdateSchema, isAuthOwner, type SiteConfig } from '@/shared/auth'
import { resolveUploadPolicy, UPLOAD_POLICY_KEY } from '../upload-policy'
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
    const [setting, session, uploads] = await Promise.all([
      resolveAllowRegister(ctx.db.orm, ctx.env.ALLOW_REGISTER),
      ctx.auth.instance.api.getSession({ headers: c.req.raw.headers }),
      resolveUploadPolicy(ctx.db.orm),
    ])
    const config: SiteConfig = { allowRegister: setting.value, uploads }
    if (session && !session.user.banned && isAuthOwner(session.user)) config.audit = isAuditEnabled(ctx.env.ENABLE_AUDIT)
    // The body depends on who asks.
    return c.json(config, 200, { 'cache-control': 'private, no-store' })
  })
  return r
}

export function adminSiteSettingsRoutes(ctx: Context) {
  const r = new Hono<ApiEnv>()
  r.use('/admin/*', requireAdmin(ctx))
  async function readSettings() {
    const [setting, uploads] = await Promise.all([resolveAllowRegister(ctx.db.orm, ctx.env.ALLOW_REGISTER), resolveUploadPolicy(ctx.db.orm)])
    return { allowRegister: setting.value, source: setting.source, uploads }
  }
  r.get('/admin/settings', async c => c.json(await readSettings()))
  r.put('/admin/settings', async c => {
    const body = AdminSiteSettingsUpdateSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'Invalid site settings' }, 400)
    const changes: BatchItem<'sqlite'>[] = []
    const updatedAt = new Date()
    function write(key: string, value: string | null) {
      changes.push(value === null
        ? ctx.db.orm.delete(siteSettings).where(eq(siteSettings.key, key))
        : ctx.db.orm.insert(siteSettings).values({ key, value, updatedAt })
          .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt } }))
    }
    if (body.data.allowRegister !== undefined) write('auth.allow_register', body.data.allowRegister === null ? null : String(body.data.allowRegister))
    if (body.data.uploads !== undefined) write(UPLOAD_POLICY_KEY, body.data.uploads === null ? null : JSON.stringify(body.data.uploads))
    await ctx.db.orm.batch(changes as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
    return c.json(await readSettings())
  })
  return r
}
