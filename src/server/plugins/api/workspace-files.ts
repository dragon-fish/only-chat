import type { Context } from 'cordis'
import { Hono } from 'hono'
import { zipSync } from 'fflate'
import { and, eq } from 'drizzle-orm'
import { conversations, projects } from '@/server/db/schema'
import { WORKSPACE_FILES_PLUGIN_ID } from '@/shared/plugins'
import { parseWorkspacePath, type WorkspaceMount } from '../workspace-files/path'
import { WorkspaceFiles, type WorkspaceError } from '../workspace-files/service'
import type { FileRecord } from '@/shared/workspace-files'
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

/**
 * What a browser is told a workspace file is. Only UTF-8 text can be stored, so the list is short
 * and everything unknown is served as text rather than guessed at.
 */
const PREVIEW_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml; charset=utf-8',
}

/**
 * A short-lived ticket standing in for the session cookie. A sandboxed frame has an opaque origin,
 * so every subresource it asks for — the stylesheet beside the page — counts as cross-site and
 * arrives without cookies. The ticket lives in the URL's directory prefix instead, which is exactly
 * what a relative `./style.css` keeps, and it grants read access to one mount for a few minutes.
 */
const PREVIEW_TICKET_TTL_SECONDS = 600

interface PreviewTicket {
  userId: number
  mount: WorkspaceMount
  scopeId: number
}

async function previewUrlFor(ctx: Context, userId: number, record: FileRecord): Promise<string | null> {
  const config = await ctx.pluginConfig.read(userId, WORKSPACE_FILES_PLUGIN_ID)
  if (config.html_preview !== true) return null
  const mount: WorkspaceMount = record.projectId !== null ? 'project' : 'conversation'
  const scopeId = record.projectId ?? record.conversationId
  if (scopeId === null) return null

  const token = crypto.randomUUID().replaceAll('-', '')
  const ticket: PreviewTicket = { userId, mount, scopeId }
  await ctx.env.KV.put(`workspace-preview:${token}`, JSON.stringify(ticket), { expirationTtl: PREVIEW_TICKET_TTL_SECONDS })
  const path = record.relativePath.split('/').map(encodeURIComponent).join('/')
  return `/api/workspace-preview/${token}/${path}`
}

/**
 * Serves workspace files to a sandboxed frame so a page the model wrote across several files
 * renders with the stylesheet and script beside it. Mounted before the session guard on purpose:
 * the ticket in the path is the credential, because the frame cannot send the cookie. Every
 * response carries a CSP sandbox, so even a direct navigation lands in an opaque origin that cannot
 * read this app's cookies. It is still model-written code, which is why the plugin setting that
 * mints these tickets is off until someone turns it on.
 */
/**
 * An archive may be narrowed to one folder, which is how a page and the files it references travel
 * together without everything else. `null` rejects a prefix the model could not have written.
 */
function archivePrefix(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return ''
  const trimmed = raw.endsWith('/') ? raw.slice(0, -1) : raw
  const parsed = parseWorkspacePath(`/project/${trimmed}`)
  return parsed.ok && parsed.value.relativePath !== '' ? `${parsed.value.relativePath}/` : null
}

/** The archive is named after the folder when there is one, so two downloads never collide. */
function archiveName(prefix: string, fallback: string): string {
  const folder = prefix === '' ? '' : prefix.slice(0, -1).split('/').pop()
  return `${folder || fallback}.zip`
}

export function workspacePreviewRoutes(ctx: Context) {
  const r = new Hono<ApiEnv>()

  r.get('/workspace-preview/:token/*', async (c) => {
    const token = c.req.param('token')
    if (!/^[0-9a-f]{32}$/.test(token)) return c.json({ error: 'not found' }, 404)
    const ticket = await ctx.env.KV.get<PreviewTicket>(`workspace-preview:${token}`, 'json')
    if (!ticket) return c.json({ error: 'not found' }, 404)
    // The setting can have been turned off since the ticket was minted; it decides, not the ticket.
    const config = await ctx.pluginConfig.read(ticket.userId, WORKSPACE_FILES_PLUGIN_ID)
    if (config.html_preview !== true) return c.json({ error: 'not found' }, 404)

    const marker = `/workspace-preview/${token}/`
    const tail = c.req.path.slice(c.req.path.indexOf(marker) + marker.length)
    let relativePath: string
    try { relativePath = decodeURIComponent(tail) }
    catch { return c.json({ error: 'invalid path' }, 400) }
    // The model's own addressing rules decide what a path may be here too, so a preview URL can
    // never reach something `write_file` could not have created.
    const parsed = parseWorkspacePath(`/${ticket.mount}/${relativePath}`)
    if (!parsed.ok || parsed.value.relativePath === '') return c.json({ error: 'invalid path' }, 400)

    const scope = ticket.mount === 'project'
      ? { conversationId: 0, projectId: ticket.scopeId }
      : { conversationId: ticket.scopeId, projectId: null }
    const files = new WorkspaceFiles(ctx.db.orm, ctx.assets, ticket.userId)
    const result = await files.readBytes(ticket.mount, scope, parsed.value.relativePath)
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error])

    const extension = parsed.value.relativePath.split('.').pop()?.toLowerCase() ?? ''
    return new Response(result.value as unknown as BodyInit, {
      headers: {
        'content-type': PREVIEW_TYPES[extension] ?? 'text/plain; charset=utf-8',
        'content-security-policy': 'sandbox allow-scripts allow-forms allow-modals',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
    })
  })

  return r
}

export function workspaceFileRoutes(ctx: Context) {
  const r = new Hono<ApiEnv>()
  const db = ctx.db.orm

  /**
   * The service needs only storage and the database, both of which the Worker has, so the file
   * panel does not have to route through the Durable Object to read a list.
   */
  const filesFor = (userId: number) => new WorkspaceFiles(db, ctx.assets, userId)

  /**
   * One archive of a whole mount. Stored, not deflated: the entries are small text files and the
   * point is to keep their relative layout intact so an HTML page finds the stylesheet beside it.
   */
  function zipResponse(entries: Array<{ relativePath: string, bytes: Uint8Array }>, name: string) {
    const archive = zipSync(Object.fromEntries(entries.map(entry => [entry.relativePath, entry.bytes])), { level: 0 })
    return new Response(archive as unknown as BodyInit, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'x-content-type-options': 'nosniff',
      },
    })
  }

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

  r.get('/projects/:id/files/archive', async (c) => {
    const userId = authUserId(c)
    const projectId = parseId(c.req.param('id'))
    if (projectId === null) return c.json({ error: 'invalid id' }, 400)
    const [project] = await db.select({ id: projects.id, name: projects.name }).from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.user_id, userId))).limit(1)
    if (!project) return c.json({ error: 'not found' }, 404)

    const prefix = archivePrefix(c.req.query('prefix'))
    if (prefix === null) return c.json({ error: 'invalid prefix' }, 400)
    const result = await filesFor(userId).readMount('project', { conversationId: 0, projectId }, prefix)
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error])
    return zipResponse(result.value, archiveName(prefix, project.name || 'project'))
  })

  r.get('/conversations/:id/files/archive', async (c) => {
    const userId = authUserId(c)
    const conversationId = parseId(c.req.param('id'))
    if (conversationId === null) return c.json({ error: 'invalid id' }, 400)
    const [conversation] = await db.select({ id: conversations.id, title: conversations.title, project_id: conversations.project_id })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.user_id, userId))).limit(1)
    if (!conversation) return c.json({ error: 'not found' }, 404)

    const prefix = archivePrefix(c.req.query('prefix'))
    if (prefix === null) return c.json({ error: 'invalid prefix' }, 400)
    const result = await filesFor(userId).readMount('conversation', { conversationId, projectId: conversation.project_id }, prefix)
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error])
    return zipResponse(result.value, archiveName(prefix, conversation.title || 'conversation'))
  })

  r.get('/workspace-files/:id', async (c) => {
    const userId = authUserId(c)
    const fileId = parseId(c.req.param('id'))
    if (fileId === null) return c.json({ error: 'invalid id' }, 400)
    const result = await filesFor(userId).readById(fileId)
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error])
    return c.json({ ...result.value, previewUrl: await previewUrlFor(ctx, userId, result.value.record) })
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
