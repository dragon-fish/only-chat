import { Context } from 'cordis'
import { Hono } from 'hono'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { meRoutes } from './me'
import { sessionRoutes } from './sessions'
import { providerRoutes } from './providers'
import { modelRoutes } from './models'
import { attachmentRoutes } from './attachments'
import { projectRoutes } from './projects'
import { modelCatalogRoutes } from './model-catalog'

export type ApiApp = Hono<{ Bindings: Env }>

export const ApiPlugin = {
  name: 'api',
  inject: ['env', 'db', 'assets', 'modelCatalog'],
  apply(ctx: Context) {
    const app: ApiApp = new Hono()
    app.get('/api/health', (c) => c.json({ ok: true }))
    app.get('/ws', (c) => {
      if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected websocket', 426)
      // R17: browsers always send Origin, so a mismatch there means some other site's page is
      // trying to open this socket cross-origin. Non-browser clients send no Origin at all and
      // are allowed through — Cloudflare Access still gates the request in front of the Worker.
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
      return c.env.USER_HUB.getByName(String(DEFAULT_USER_ID)).fetch(c.req.raw)
    })
    app.route('/api', meRoutes(ctx))
    app.route('/api', sessionRoutes(ctx))
    app.route('/api', providerRoutes(ctx))
    app.route('/api', modelRoutes(ctx))
    app.route('/api', attachmentRoutes(ctx))
    app.route('/api', projectRoutes(ctx))
    app.route('/api', modelCatalogRoutes(ctx))
    app.onError((err, c) => {
      console.error('api error', err)
      return c.json({ error: err.message }, 500)
    })
    ctx.provide('api', app)
  },
}
