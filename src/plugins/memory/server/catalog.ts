import { and, desc, eq, isNull, or } from 'drizzle-orm'
import type { DB } from '@/server/db/client'
import { memories, memorySnapshots, workspaceFiles } from '@/server/db/schema'
import { MEMORY_SAVE_TOOL_ID } from '@/shared/plugins'
import type { MemoryScopes, MemoryType } from '../shared'

/** One line of the catalog. A file nobody described has neither a type nor a description. */
export interface CatalogEntry {
  path: string
  type: MemoryType | null
  description: string | null
}

/** Per scope. Past it the catalog says how many more there are and how to list them. */
export const CATALOG_LIMIT = 200

/** A layer this conversation does not use: said once, so the model neither reads nor saves there. */
export type ClosedScope = 'off'

const CLOSED_NOTE: Record<string, string> = {
  user: 'User memory is off in this conversation: do not read or save anything under /memory/user.',
  project: 'Project memory is off in this conversation: do not read or save anything under /memory/project.',
}

function scopeBlock(name: string, mount: string, entries: readonly CatalogEntry[] | ClosedScope): string {
  if (entries === 'off') return [`<scope name="${name}">`, CLOSED_NOTE[name]!, '</scope>'].join('\n')
  const lines = entries.slice(0, CATALOG_LIMIT).map(entry => entry.type === null || entry.description === null
    ? `- ${entry.path} — undescribed: give it a type and description with ${MEMORY_SAVE_TOOL_ID}`
    : `- ${entry.path} (${entry.type}) — ${entry.description}`)
  if (entries.length > CATALOG_LIMIT) lines.push(`… and ${entries.length - CATALOG_LIMIT} more: list_files /${mount}`)
  return [`<scope name="${name}">`, ...(lines.length > 0 ? lines : ['(empty)']), '</scope>'].join('\n')
}

/**
 * The text that leads a conversation's first message. Pure, so the same memories always render
 * the same bytes. `project` is null for a conversation outside any Project, which has no project
 * scope at all rather than an empty one; `'off'` is a layer this conversation has switched off.
 */
export function renderCatalog(user: readonly CatalogEntry[] | ClosedScope, project: readonly CatalogEntry[] | ClosedScope | null): string {
  return [
    '<memory-catalog>',
    'Your memory as it stood when this conversation started; memories saved since then are not listed. Read a file before relying on it.',
    scopeBlock('user', 'memory/user', user),
    ...(project === null ? [] : [scopeBlock('project', 'memory/project', project)]),
    '</memory-catalog>',
  ].join('\n')
}

/** Live files in the open memory mounts, newest first, each with its description when it has one. */
export async function loadCatalog(
  db: DB, userId: number, projectId: number | null, scopes: MemoryScopes,
): Promise<{ user: CatalogEntry[] | ClosedScope, project: CatalogEntry[] | ClosedScope | null }> {
  const project = scopes.project && projectId !== null
  const rows = !scopes.user && !project ? [] : await db.select({
    mount: workspaceFiles.mount,
    relativePath: workspaceFiles.relative_path,
    type: memories.type,
    description: memories.description,
  })
    .from(workspaceFiles)
    .leftJoin(memories, eq(memories.file_id, workspaceFiles.id))
    .where(and(
      eq(workspaceFiles.user_id, userId),
      isNull(workspaceFiles.deleted_at),
      or(
        scopes.user ? eq(workspaceFiles.mount, 'memory/user') : undefined,
        project ? and(eq(workspaceFiles.mount, 'memory/project'), eq(workspaceFiles.project_id, projectId)) : undefined,
      ),
    ))
    // The id breaks ties so two files written in the same millisecond still render in one order.
    .orderBy(desc(workspaceFiles.updated_at), desc(workspaceFiles.id))

  const entry = (row: typeof rows[number]): CatalogEntry => ({
    path: `/${row.mount}/${row.relativePath}`, type: row.type, description: row.description,
  })
  return {
    user: scopes.user ? rows.filter(row => row.mount === 'memory/user').map(entry) : 'off',
    project: projectId === null ? null : project ? rows.filter(row => row.mount === 'memory/project').map(entry) : 'off',
  }
}

/** How a snapshot records which layers were open when it was rendered. */
export function scopesKey(scopes: MemoryScopes): string {
  return [scopes.user ? 'user' : null, scopes.project ? 'project' : null].filter(Boolean).join(',')
}

/**
 * The catalog this conversation leads with: the stored one while it was rendered for the
 * conversation's current Project and the same open layers, otherwise a fresh one.
 *
 * Written conditionally and read back, never written and returned: two generations of one
 * conversation can both find nothing stored, and whichever lands first is the catalog both use —
 * a turn that used its own losing copy would rebuild a different prefix on the next turn.
 */
export async function memoryPreamble(
  db: DB, userId: number, conversationId: number, projectId: number | null, scopes: MemoryScopes,
): Promise<string> {
  const key = scopesKey(scopes)
  const stored = await readSnapshot(db, conversationId)
  if (stored && stored.project_id === projectId && stored.scopes === key) return stored.text

  const catalog = await loadCatalog(db, userId, projectId, scopes)
  const text = renderCatalog(catalog.user, catalog.project)
  const now = Date.now()
  if (!stored) {
    await db.insert(memorySnapshots).values({ conversation_id: conversationId, project_id: projectId, scopes: key, text, created_at: now })
      .onConflictDoNothing()
  }
  else {
    // Only over the stale one this turn saw; a concurrent turn that already replaced it wins.
    await db.update(memorySnapshots).set({ project_id: projectId, scopes: key, text, created_at: now }).where(and(
      eq(memorySnapshots.conversation_id, conversationId),
      stored.project_id === null ? isNull(memorySnapshots.project_id) : eq(memorySnapshots.project_id, stored.project_id),
      eq(memorySnapshots.scopes, stored.scopes),
    ))
  }
  const settled = await readSnapshot(db, conversationId)
  if (!settled) throw new Error(`memory snapshot for conversation ${conversationId} vanished while it was written`)
  return settled.text
}

async function readSnapshot(db: DB, conversationId: number) {
  const [row] = await db.select().from(memorySnapshots).where(eq(memorySnapshots.conversation_id, conversationId)).limit(1)
  return row
}

/** A fork replays the source's messages, so it replays the catalog in front of them too. */
export async function copySnapshot(db: DB, sourceConversationId: number, targetConversationId: number): Promise<void> {
  const stored = await readSnapshot(db, sourceConversationId)
  if (!stored) return
  await db.insert(memorySnapshots).values({ ...stored, conversation_id: targetConversationId }).onConflictDoNothing()
}
