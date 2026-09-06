import type { Context } from 'cordis'
import { Hono } from 'hono'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { listProjects } from '../hub/projects'

/** Read-only: all Project writes go through UserHub (spec §5.1). */
export function projectRoutes(ctx: Context) {
  const r = new Hono<{ Bindings: Env }>()
  r.get('/projects', async (c) => c.json(await listProjects(ctx.db.orm, DEFAULT_USER_ID)))
  return r
}
