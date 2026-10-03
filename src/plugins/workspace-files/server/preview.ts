import type { Context } from 'cordis'
import { WORKSPACE_FILES_PLUGIN_ID } from '@/shared/plugins'
import { PLUGIN_API_PREFIX } from '@/server/plugins/api'
import type { WorkspaceMount } from '@/server/plugins/workspace-files/path'
import type { WorkspaceScope } from '@/server/plugins/workspace-files/service'
import type { FileRecord } from '@/shared/workspace-files'

/**
 * Minting preview tickets, shared by the REST route that feeds the Files panel and the tool that
 * hands a link to the model. Both need the same URL, and a second copy of this would be a second
 * place for the ticket's shape to drift.
 */

export const PREVIEW_SEGMENT = 'preview'

/**
 * What a browser is told a workspace file is. Only UTF-8 text can be stored, so the list is short
 * and everything unknown is served as text rather than guessed at.
 */
export const PREVIEW_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml; charset=utf-8',
}

/** The content type a path would be served as, or undefined when it can only be text. */
export function previewTypeFor(relativePath: string): string | undefined {
  return PREVIEW_TYPES[relativePath.split('.').pop()?.toLowerCase() ?? '']
}

/**
 * A short-lived ticket standing in for the session cookie. A sandboxed frame has an opaque origin,
 * so every subresource it asks for — the stylesheet beside the page — counts as cross-site and
 * arrives without cookies. The ticket lives in the URL's directory prefix instead, which is exactly
 * what a relative `./style.css` keeps, and it grants read access to one mount for a few minutes.
 */
export const PREVIEW_TICKET_TTL_SECONDS = 600

export interface PreviewTicket {
  userId: number
  mount: WorkspaceMount
  /** The conversation, the Project, or for `/memory/user` the user — whatever the mount is keyed on. */
  scopeId: number
}

/**
 * The scope a ticket grants, rebuilt from the mount it names. A ticket is only minted for a file its
 * caller could reach, so memory is open here exactly when the ticket is for a memory mount; it is
 * not re-checked against the plugin switch while the ticket lives.
 */
export function ticketScope(ticket: PreviewTicket): WorkspaceScope {
  switch (ticket.mount) {
    case 'conversation': return { conversationId: ticket.scopeId, projectId: null, memory: { user: false, project: false } }
    case 'project': return { conversationId: 0, projectId: ticket.scopeId, memory: { user: false, project: false } }
    case 'memory/user': return { conversationId: 0, projectId: null, memory: { user: true, project: false } }
    case 'memory/project': return { conversationId: 0, projectId: ticket.scopeId, memory: { user: false, project: true } }
  }
}

/** The app-relative preview path for a file, or null when its mount has no id to scope a ticket to. */
export async function previewUrlFor(ctx: Context, userId: number, record: FileRecord): Promise<string | null> {
  const scopeId = record.mount === 'memory/user' ? userId
    : record.mount === 'conversation' ? record.conversationId : record.projectId
  if (scopeId === null) return null

  const token = crypto.randomUUID().replaceAll('-', '')
  const ticket: PreviewTicket = { userId, mount: record.mount, scopeId }
  await ctx.env.KV.put(`workspace-preview:${token}`, JSON.stringify(ticket), { expirationTtl: PREVIEW_TICKET_TTL_SECONDS })
  const path = record.relativePath.split('/').map(encodeURIComponent).join('/')
  return `${PLUGIN_API_PREFIX}/${WORKSPACE_FILES_PLUGIN_ID}/${PREVIEW_SEGMENT}/${token}/${path}`
}

/**
 * The same path as an absolute URL, for a reader that is not already on this origin — the model
 * quoting it to the operator, or a remote browser told to open it.
 *
 * The origin comes from the runtime, which took it from the browser's own connection: a tool runs
 * inside the Durable Object during generation, where there is no inbound request to read one off.
 * Never from configuration — a pinned host would send a worktree's links to production.
 */
export function absolutePreviewUrl(publicOrigin: string, path: string): string {
  return new URL(path, publicOrigin).toString()
}
