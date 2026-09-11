import type { Context } from 'cordis'
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { conversations, projects } from '@/server/db/schema'
import { WorkspaceFiles, type WorkspaceError } from '../workspace-files/service'
import { authUserId, type ApiEnv } from './auth'
import { parseId } from './params'

/** HTTP status for each expected failure. Everything else throws and becomes a 500. */
const STATUS: Record<WorkspaceError, 400 | 404 | 409> = {
  INVALID_PATH: 400,
  MOUNT_UNAVAILABLE: 404,
  FILE_NOT_FOUND: 404,
  FILE_ALREADY_EXISTS: 409,
  VERSION_CONFLICT: 409,
  VERSION_NOT_FOUND: 404,
  FILE_TOO_LARGE: 400,
  INVALID_UTF8: 400,
  READ_RANGE_TOO_LARGE: 400,
}

export function workspaceFileRoutes(ctx: Context) {
  const r = new Hono<ApiEnv>()
  const db = ctx.db.orm

  /**
   * The service needs only storage and the database, both of which the Worker has, so the file
   * panel does not have to route through the Durable Object to read a list.
   */
  const filesFor = (userId: number) => new WorkspaceFiles(db, ctx.assets, userId)

  r.get('/projects/:id/files', async (c) => {
    const userId = authUserId(c)
    const projectId = parseId(c.req.param('id'))
    if (projectId === null) return c.json({ error: 'invalid id' }, 400)
    // Ownership of the container is checked before its contents are named.
    const [project] = await db.select({ id: projects.id }).from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.user_id, userId))).limit(1)
    if (!project) return c.json({ error: 'not found' }, 404)

    const result = await filesFor(userId).listRecords('project', { conversationId: 0, projectId })
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error])
    return c.json({ files: result.value })
  })

  r.get('/conversations/:id/files', async (c) => {
    const userId = authUserId(c)
    const conversationId = parseId(c.req.param('id'))
    if (conversationId === null) return c.json({ error: 'invalid id' }, 400)
    const [conversation] = await db.select({ id: conversations.id, project_id: conversations.project_id })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.user_id, userId))).limit(1)
    if (!conversation) return c.json({ error: 'not found' }, 404)

    const files = filesFor(userId)
    const own = await files.listRecords('conversation', { conversationId, projectId: conversation.project_id })
    if (!own.ok) return c.json({ error: own.error }, STATUS[own.error])
    // The project mount is shown alongside so a reader can see what this conversation can also reach.
    const shared = conversation.project_id === null
      ? { ok: true as const, value: [] }
      : await files.listRecords('project', { conversationId, projectId: conversation.project_id })
    if (!shared.ok) return c.json({ error: shared.error }, STATUS[shared.error])
    return c.json({ files: own.value, projectFiles: shared.value, projectId: conversation.project_id })
  })

  r.get('/workspace-files/:id', async (c) => {
    const userId = authUserId(c)
    const fileId = parseId(c.req.param('id'))
    if (fileId === null) return c.json({ error: 'invalid id' }, 400)
    const result = await filesFor(userId).readById(fileId)
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error])
    return c.json(result.value)
  })

  r.get('/workspace-files/:id/download', async (c) => {
    const userId = authUserId(c)
    const fileId = parseId(c.req.param('id'))
    if (fileId === null) return c.json({ error: 'invalid id' }, 400)
    const result = await filesFor(userId).readById(fileId)
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error])

    const name = result.value.record.relativePath.split('/').pop() ?? 'file.txt'
    return new Response(result.value.content, {
      headers: {
        // Always a download and never a rendered page: this content was written by a model.
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'x-content-type-options': 'nosniff',
      },
    })
  })

  r.delete('/workspace-files/:id', async (c) => {
    const userId = authUserId(c)
    const fileId = parseId(c.req.param('id'))
    if (fileId === null) return c.json({ error: 'invalid id' }, 400)
    const result = await filesFor(userId).softDelete(fileId)
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error])
    return c.body(null, 204)
  })

  return r
}
