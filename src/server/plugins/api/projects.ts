import type { Context } from 'cordis'
import { Hono } from 'hono'
import { authUserId, type ApiEnv } from './auth'
import { listProjects } from '../hub/projects'

/** Read-only: all Project writes go through UserHub (spec §5.1). */
export function projectRoutes(ctx: Context) {
  const r = new Hono<ApiEnv>()
  r.get('/projects', async (c) => c.json(await listProjects(ctx.db.orm, authUserId(c))))
  return r
}
