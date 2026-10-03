import { and, desc, eq, isNull, or } from 'drizzle-orm'
import type { DB } from '@/server/db/client'
import { memories, memorySnapshots, workspaceFiles } from '@/server/db/schema'
import { MEMORY_SAVE_TOOL_ID } from '@/shared/plugins'
import type { MemoryType } from '../shared'

/** One line of the catalog. A file nobody described has neither a type nor a description. */
export interface CatalogEntry {
  path: string
  type: MemoryType | null
  description: string | null
}

/** Per scope. Past it the catalog says how many more there are and how to list them. */
export const CATALOG_LIMIT = 200

function scopeBlock(name: string, mount: string, entries: readonly CatalogEntry[]): string {
  const lines = entries.slice(0, CATALOG_LIMIT).map(entry => entry.type === null || entry.description === null
    ? `- ${entry.path} — undescribed: give it a type and description with ${MEMORY_SAVE_TOOL_ID}`
    : `- ${entry.path} (${entry.type}) — ${entry.description}`)
  if (entries.length > CATALOG_LIMIT) lines.push(`… and ${entries.length - CATALOG_LIMIT} more: list_files /${mount}`)
  return [`<scope name="${name}">`, ...(lines.length > 0 ? lines : ['(empty)']), '</scope>'].join('\n')
}

/**
 * The text that leads a conversation's first message. Pure, so the same memories always render
 * the same bytes. `project` is null for a conversation outside any Project, which has no project
 * scope at all rather than an empty one.
 */
export function renderCatalog(user: readonly CatalogEntry[], project: readonly CatalogEntry[] | null): string {
  return [
    '<memory-catalog>',
    'Your memory as it stood when this conversation started; memories saved since then are not listed. Read a file before relying on it.',
    scopeBlock('user', 'memory/user', user),
    ...(project === null ? [] : [scopeBlock('project', 'memory/project', project)]),
    '</memory-catalog>',
  ].join('\n')
}

/** Live files in both memory mounts, newest first, each with its description when it has one. */
export async function loadCatalog(db: DB, userId: number, projectId: number | null): Promise<{ user: CatalogEntry[], project: CatalogEntry[] | null }> {
  const rows = await db.select({
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
      projectId === null
        ? eq(workspaceFiles.mount, 'memory/user')
        : or(eq(workspaceFiles.mount, 'memory/user'), and(eq(workspaceFiles.mount, 'memory/project'), eq(workspaceFiles.project_id, projectId))),
    ))
    // The id breaks ties so two files written in the same millisecond still render in one order.
    .orderBy(desc(workspaceFiles.updated_at), desc(workspaceFiles.id))

  const entry = (row: typeof rows[number]): CatalogEntry => ({
    path: `/${row.mount}/${row.relativePath}`, type: row.type, description: row.description,
  })
  return {
    user: rows.filter(row => row.mount === 'memory/user').map(entry),
    project: projectId === null ? null : rows.filter(row => row.mount === 'memory/project').map(entry),
  }
}

/**
 * The catalog this conversation leads with: the stored one while it was rendered for the
 * conversation's current Project, otherwise a fresh one.
 *
 * Written conditionally and read back, never written and returned: two generations of one
 * conversation can both find nothing stored, and whichever lands first is the catalog both use —
 * a turn that used its own losing copy would rebuild a different prefix on the next turn.
 */
export async function memoryPreamble(db: DB, userId: number, conversationId: number, projectId: number | null): Promise<string> {
  const stored = await readSnapshot(db, conversationId)
  if (stored && stored.project_id === projectId) return stored.text

  const catalog = await loadCatalog(db, userId, projectId)
  const text = renderCatalog(catalog.user, catalog.project)
  const now = Date.now()
  if (!stored) {
    await db.insert(memorySnapshots).values({ conversation_id: conversationId, project_id: projectId, text, created_at: now })
      .onConflictDoNothing()
  }
  else {
    // Only over the stale one this turn saw; a concurrent turn that already replaced it wins.
    await db.update(memorySnapshots).set({ project_id: projectId, text, created_at: now }).where(and(
      eq(memorySnapshots.conversation_id, conversationId),
      stored.project_id === null ? isNull(memorySnapshots.project_id) : eq(memorySnapshots.project_id, stored.project_id),
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
