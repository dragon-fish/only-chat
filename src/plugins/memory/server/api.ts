import type { Context } from 'cordis'
import { Hono } from 'hono'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { DB } from '@/server/db/client'
import { memories, projects, workspaceFiles } from '@/server/db/schema'
import { authUserId, type ApiEnv } from '@/server/plugins/api/auth'
import { parseId } from '@/server/plugins/api/params'
import { MEMORY_PLUGIN_ID, type MemoryListItem } from '../shared'

/**
 * Every live memory in one mount, newest first. The management pages ignore the memory switches on
 * purpose: a layer switched off is hidden from the model, never from its owner.
 */
async function listMemories(db: DB, userId: number, target: { mount: 'memory/user' } | { mount: 'memory/project', projectId: number }): Promise<MemoryListItem[]> {
  const rows = await db.select({
    fileId: workspaceFiles.id,
    mount: workspaceFiles.mount,
    relativePath: workspaceFiles.relative_path,
    updatedAt: workspaceFiles.updated_at,
    type: memories.type,
    description: memories.description,
  })
    .from(workspaceFiles)
    .leftJoin(memories, eq(memories.file_id, workspaceFiles.id))
    .where(and(
      eq(workspaceFiles.user_id, userId),
      eq(workspaceFiles.mount, target.mount),
      target.mount === 'memory/project' ? eq(workspaceFiles.project_id, target.projectId) : undefined,
      isNull(workspaceFiles.deleted_at),
    ))
    .orderBy(desc(workspaceFiles.updated_at), desc(workspaceFiles.id))
  return rows.map(row => ({
    fileId: row.fileId,
    path: `/${row.mount}/${row.relativePath}`,
    name: row.relativePath.slice(row.relativePath.lastIndexOf('/') + 1).replace(/\.[^.]+$/, ''),
    type: row.type,
    description: row.description,
    updatedAt: row.updatedAt,
  }))
}

/**
 * The management pages' reads, on the Worker where the API lives. Viewing a memory's body and
 * deleting it go through the workspace file routes, which already do both for any file the user owns.
 */
export const MemoryApiPlugin = {
  name: 'memory-api',
  inject: ['pluginApi', 'db'] as const,
  apply(ctx: Context) {
    const r = new Hono<ApiEnv>()
    const db = ctx.db.orm

    r.get('/memories', async (c) => {
      return c.json({ memories: await listMemories(db, authUserId(c), { mount: 'memory/user' }) })
    })

    r.get('/projects/:id/memories', async (c) => {
      const userId = authUserId(c)
      const projectId = parseId(c.req.param('id'))
      if (projectId === null) return c.json({ error: 'invalid id' }, 400)
      const [project] = await db.select({ id: projects.id }).from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.user_id, userId))).limit(1)
      if (!project) return c.json({ error: 'not found' }, 404)
      return c.json({ memories: await listMemories(db, userId, { mount: 'memory/project', projectId }) })
    })

    ctx.pluginApi.register(MEMORY_PLUGIN_ID, r)
  },
}
