import { Context } from 'cordis'
import { Hono } from 'hono'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { meRoutes } from './me'
import { sessionRoutes } from './sessions'
import { providerRoutes } from './providers'
import { modelRoutes } from './models'
import { attachmentRoutes } from './attachments'

export type ApiApp = Hono<{ Bindings: Env }>

export const ApiPlugin = {
  name: 'api',
  inject: ['env', 'db', 'assets'],
  apply(ctx: Context) {
    const app: ApiApp = new Hono()
    app.get('/api/health', (c) => c.json({ ok: true }))
    app.get('/ws', (c) => {
      if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected websocket', 426)
      return c.env.USER_HUB.getByName(String(DEFAULT_USER_ID)).fetch(c.req.raw)
    })
    app.route('/api', meRoutes(ctx))
    app.route('/api', sessionRoutes(ctx))
    app.route('/api', providerRoutes(ctx))
    app.route('/api', modelRoutes(ctx))
    app.route('/api', attachmentRoutes(ctx))
    app.onError((err, c) => {
      console.error('api error', err)
      return c.json({ error: err.message }, 500)
    })
    ctx.provide('api', app)
  },
}
