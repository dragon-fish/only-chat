import type { Context } from 'cordis'
import { Hono } from 'hono'
import { disposeRpcStub } from '@/server/rpc'

export function modelCatalogRoutes(ctx: Context) {
  const app = new Hono<{ Bindings: Env }>()
  app.get('/model-catalog/status', async c => c.json(await ctx.modelCatalog.status()))
  app.get('/model-catalog/providers', async c => {
    const query = c.req.query('q')?.trim().toLowerCase() ?? ''
    const providers = Object.values(await ctx.modelCatalog.providerIndex())
    return c.json(providers.filter(provider => `${provider.id} ${provider.name}`.toLowerCase().includes(query)))
  })
  app.post('/model-catalog/refresh', async c => {
    const instance = await ctx.env.MODEL_CATALOG_REFRESH.create({
      id: `catalog-manual-${crypto.randomUUID()}`,
      params: { source: 'manual' },
    })
    try { return c.json({ instanceId: instance.id }, 202) }
    finally { disposeRpcStub(instance) }
  })
  app.get('/model-catalog/refresh/:instanceId', async c => {
    const id = c.req.param('instanceId')
    if (!/^catalog-(?:manual|cron)-[a-zA-Z0-9-]{1,128}$/u.test(id)) return c.json({ error: 'not found' }, 404)
    try {
      const instance = await ctx.env.MODEL_CATALOG_REFRESH.get(id)
      try {
        const status = await instance.status()
        return c.json({ status: status.status, ...(status.error?.message ? { error: status.error.message } : {}) })
      } finally { disposeRpcStub(instance) }
    } catch {
      return c.json({ error: 'not found' }, 404)
    }
  })
  return app
}
