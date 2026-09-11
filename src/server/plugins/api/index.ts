import { Context } from 'cordis'
import { Hono } from 'hono'
import { INTERNAL_USER_ID_HEADER, INTERNAL_AUTH_SESSION_ID_HEADER } from '../hub/identity'
import { meRoutes } from './me'
import { conversationRoutes } from './conversations'
import { providerRoutes } from './providers'
import { modelRoutes } from './models'
import { attachmentRoutes } from './attachments'
import { projectRoutes } from './projects'
import { modelCatalogRoutes } from './model-catalog'
import { CatalogUnavailableError } from '../model-catalog/storage'
import { authUserId, requireAdmin, requireAuth, type ApiEnv } from './auth'
import { adminEndpoints } from '../auth/access'
import { AdminCreateUserSchema, AdminSetRoleSchema } from '@/shared/auth'
import { adminSiteSettingsRoutes, publicSiteSettingsRoutes } from './site-settings'
import { artifactRoutes } from './artifacts'
import { pluginConfigRoutes } from './plugin-config'

export type ApiApp = Hono<ApiEnv>

export const ApiPlugin = {
  name: 'api',
  inject: ['env', 'db', 'auth', 'assets', 'modelCatalog', 'pluginConfig'],
  apply(ctx: Context) {
    const app: ApiApp = new Hono()
    app.use('/api/auth/admin/*', async (c, next) => {
      if (!adminEndpoints.has(`${c.req.method} ${c.req.path}`)) return c.json({ error: 'Forbidden' }, 403)
      await next()
    })
    app.use('/api/auth/admin/*', requireAuth(ctx), requireAdmin(ctx))
    app.use('/api/auth/admin/*', async (c, next) => {
      const schema = c.req.path.endsWith('/create-user') ? AdminCreateUserSchema : c.req.path.endsWith('/set-role') ? AdminSetRoleSchema : null
      if (schema && !schema.safeParse(await c.req.raw.clone().json().catch(() => null)).success) return c.json({ error: 'Invalid account input' }, 400)
      await next()
    })
    app.all('/api/auth/*', c => ctx.auth.instance.handler(c.req.raw))
    app.get('/api/health', (c) => c.json({ ok: true }))
    app.route('/api', publicSiteSettingsRoutes(ctx))
    app.use('/api/*', requireAuth(ctx))
    app.use('/ws', requireAuth(ctx))
    app.route('/api', adminSiteSettingsRoutes(ctx))
    app.get('/ws', (c) => {
      if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected websocket', 426)
      // R17: browsers always send Origin, so a mismatch there means some other site's page is
      // trying to open this socket cross-origin. Authenticated non-browser clients may omit Origin.
      const origin = c.req.header('Origin')
      if (origin) {
        const requestHost = new URL(c.req.url).host.toLowerCase()
        let originHost: string
        try {
          originHost = new URL(origin).host.toLowerCase()
        } catch {
          return c.json({ error: 'origin not allowed' }, 403)
        }
        if (originHost !== requestHost) return c.json({ error: 'origin not allowed' }, 403)
      }
      const userId = authUserId(c)
      const headers = new Headers(c.req.raw.headers)
      headers.set(INTERNAL_USER_ID_HEADER, String(userId))
      headers.set(INTERNAL_AUTH_SESSION_ID_HEADER, c.get('authSession').session.id)
      return c.env.USER_HUB.getByName(String(userId)).fetch(new Request(c.req.raw, { headers }))
    })
    app.route('/api', meRoutes(ctx))
    app.route('/api', conversationRoutes(ctx))
    app.route('/api', providerRoutes(ctx))
    app.route('/api', modelRoutes(ctx))
    app.route('/api', attachmentRoutes(ctx))
    app.route('/api', projectRoutes(ctx))
    app.route('/api', modelCatalogRoutes(ctx))
    app.route('/api', artifactRoutes(ctx))
    app.route('/api', pluginConfigRoutes(ctx))
    app.onError((err, c) => {
      if (err instanceof CatalogUnavailableError) return c.json({ error: err.message }, 503)
      console.error('api error', err)
      return c.json({ error: err.message }, 500)
    })
    ctx.provide('api', app)
  },
}
