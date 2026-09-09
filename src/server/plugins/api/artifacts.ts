import type { Context } from 'cordis'
import { Hono } from 'hono'
import { CreateImageRunInputSchema } from '@/shared/artifacts'
import { ArtifactRunInputError, createImageRun } from '../artifacts/runs'
import { authUserId, type ApiEnv } from './auth'

export function artifactRoutes(ctx: Context) {
  const router = new Hono<ApiEnv>()
  router.post('/artifact-runs/image', async (c) => {
    const parsed = CreateImageRunInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    try { return c.json(await createImageRun(ctx, authUserId(c), parsed.data), 202) }
    catch (error) {
      if (error instanceof ArtifactRunInputError) return c.json({ error: error.message }, error.status)
      throw error
    }
  })
  return router
}
