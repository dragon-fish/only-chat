import type { Context } from 'cordis'
import { Hono } from 'hono'
import { CatalogLeaseLostError, CatalogRefreshBusyError } from '../model-catalog/lease'

export function modelCatalogRoutes(ctx: Context) {
  const app = new Hono<{ Bindings: Env }>()
  app.get('/model-catalog/status', async c => c.json(await ctx.modelCatalog.status()))
  app.get('/model-catalog/providers', async c => {
    const query = c.req.query('q')?.trim().toLowerCase() ?? ''
    const providers = Object.values(await ctx.modelCatalog.providerIndex())
    return c.json(providers.filter(provider => `${provider.id} ${provider.name}`.toLowerCase().includes(query)))
  })
  app.post('/model-catalog/refresh', async c => {
    try {
      return c.json(await ctx.modelCatalog.refresh('manual'))
    } catch (error) {
      if (error instanceof CatalogRefreshBusyError || error instanceof CatalogLeaseLostError) return c.json({ error: error.message }, 409)
      throw error
    }
  })
  return app
}
