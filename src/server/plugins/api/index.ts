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
import { auditRoutes } from './audit'
import { pluginConfigRoutes } from './plugin-config'

export type ApiApp = Hono<ApiEnv>

/**
 * Where a plugin's HTTP surface lives. Every plugin route is under its own id, so two plugins can
 * never claim the same path and a URL says which plugin answers it. Core resources stay on `/api`
 * and are not up for grabs.
 */
export const PLUGIN_API_PREFIX = '/api/plugins'

export interface PluginApi {
  /** Mounts a plugin's routes behind the session guard, under `/api/plugins/<pluginId>`. */
  register(pluginId: string, routes: ApiApp): void
  /**
   * Mounts routes that carry their own credential instead of the session cookie, under
   * `/api/plugins/<pluginId>/<segment>`. Used only where a cookie cannot travel — a sandboxed frame
   * has an opaque origin, so its own subresource requests are cross-site and arrive without one.
   */
  registerPublic(pluginId: string, segment: string, routes: ApiApp): void
}

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
    app.all('/api/auth/*', async (c) => {
      const response = await ctx.auth.instance.handler(c.req.raw)
      // Attachments are cached by the browser for a year, and the HTTP cache belongs to the browser
      // rather than to the account that filled it. The next account on this machine must not
      // inherit them, and a page cannot clear that store from script.
      if (!c.req.path.endsWith('/sign-out') || !response.ok) return response
      const cleared = new Response(response.body, response)
      cleared.headers.set('clear-site-data', '"cache"')
      return cleared
    })
    app.get('/api/health', (c) => c.json({ ok: true }))
    app.route('/api', publicSiteSettingsRoutes(ctx))
    // Hono copies a sub-app's routes at `route()` time and plugins mount after this point, so the
    // guard cannot be ordered around them. It asks instead, and a plugin path is exempt only while
    // it is in this set — which only `registerPublic` can put it in.
    const publicPluginPrefixes = new Set<string>()
    const guard = requireAuth(ctx)
    app.use('/api/*', async (c, next) => {
      for (const prefix of publicPluginPrefixes) if (c.req.path.startsWith(prefix)) return next()
      return guard(c, next)
    })
    app.use('/ws', requireAuth(ctx))
    app.route('/api', adminSiteSettingsRoutes(ctx))
    app.route('/api', auditRoutes(ctx))
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
    const pluginApi: PluginApi = {
      register(pluginId, routes) {
        app.route(`${PLUGIN_API_PREFIX}/${pluginId}`, routes)
      },
      registerPublic(pluginId, segment, routes) {
        const prefix = `${PLUGIN_API_PREFIX}/${pluginId}/${segment}`
        publicPluginPrefixes.add(`${prefix}/`)
        app.route(prefix, routes)
      },
    }
    ctx.provide('api', app)
    ctx.provide('pluginApi', pluginApi)
  },
}
