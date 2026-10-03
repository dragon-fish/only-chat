import { and, desc, eq, isNull, or } from 'drizzle-orm'
import type { DB } from '@/server/db/client'
import { memories, memorySnapshots, workspaceFiles } from '@/server/db/schema'
import { MEMORY_SAVE_TOOL_ID } from '@/shared/plugins'
import { MEMORY_CATEGORIES, MEMORY_LAYOUT, memoryCategory, type MemoryCategory, type MemoryScopes } from '../shared'

/** One line of the catalog. A file nobody described has no description. */
export interface CatalogEntry {
  path: string
  /** Null for a file outside the layout. */
  category: MemoryCategory | null
  description: string | null
}

/** One open layer: its profile in full when it has one, and a line for every other file. */
export interface ScopeCatalog {
  profile: { path: string, text: string } | null
  entries: readonly CatalogEntry[]
}

/** A layer this conversation does not use: said once, so the model neither reads nor saves there. */
export type ClosedScope = 'off'

/** Per scope. Past it the catalog says how many more there are and how to list them. */
export const CATALOG_LIMIT = 200

/**
 * The profile is read on every turn, so it travels whole rather than as a line to follow — but only
 * up to this many characters. Past it the model is told to read the rest and to shorten the file.
 */
export const PROFILE_LIMIT = 4000

const CLOSED_NOTE: Record<string, string> = {
  user: 'User memory is off in this conversation: do not read or save anything under /memory/user.',
  project: 'Project memory is off in this conversation: do not read or save anything under /memory/project.',
}

/** Lines follow the layout's order, so the files about one kind of thing sit together. */
const ORDER = [...MEMORY_CATEGORIES, null] as const

function line(entry: CatalogEntry): string {
  if (entry.category === null) return `- ${entry.path} — outside the memory layout: rename_file it to ${MEMORY_LAYOUT}`
  if (entry.description === null) return `- ${entry.path} — undescribed: describe it with ${MEMORY_SAVE_TOOL_ID}`
  return `- ${entry.path} — ${entry.description}`
}

function profileBlock(profile: { path: string, text: string }): string {
  const text = profile.text.length > PROFILE_LIMIT
    ? `${profile.text.slice(0, PROFILE_LIMIT)}\n[Cut here: read_file the rest, and shorten the profile.]`
    : profile.text
  return `<profile path="${profile.path}">\n${text.trimEnd()}\n</profile>`
}

function scopeBlock(name: string, mount: string, scope: ScopeCatalog | ClosedScope): string {
  if (scope === 'off') return [`<scope name="${name}">`, CLOSED_NOTE[name]!, '</scope>'].join('\n')
  const sorted = ORDER.flatMap(category => scope.entries.filter(entry => entry.category === category))
  const lines = sorted.slice(0, CATALOG_LIMIT).map(line)
  if (sorted.length > CATALOG_LIMIT) lines.push(`… and ${sorted.length - CATALOG_LIMIT} more: list_files /${mount}`)
  const body = [...(scope.profile ? [profileBlock(scope.profile)] : []), ...lines]
  return [`<scope name="${name}">`, ...(body.length > 0 ? body : ['(empty)']), '</scope>'].join('\n')
}

/**
 * The text that leads a conversation's first message. Pure, so the same memories always render
 * the same bytes. `project` is null for a conversation outside any Project, which has no project
 * scope at all rather than an empty one; `'off'` is a layer this conversation has switched off.
 */
export function renderCatalog(user: ScopeCatalog | ClosedScope, project: ScopeCatalog | ClosedScope | null): string {
  return [
    '<memory-catalog>',
    'Your memory as it stood when this conversation started; memories saved since then are not listed. Read a file before relying on it.',
    scopeBlock('user', 'memory/user', user),
    ...(project === null ? [] : [scopeBlock('project', 'memory/project', project)]),
    '</memory-catalog>',
  ].join('\n')
}

/** Reads one memory file's text, or null when it is gone or not text. */
export type ReadMemoryFile = (mount: 'memory/user' | 'memory/project', relativePath: string) => Promise<string | null>

/** Live files in the open memory mounts, newest first, with each layer's profile read in full. */
export async function loadCatalog(
  db: DB, userId: number, projectId: number | null, scopes: MemoryScopes, readFile: ReadMemoryFile,
): Promise<{ user: ScopeCatalog | ClosedScope, project: ScopeCatalog | ClosedScope | null }> {
  const project = scopes.project && projectId !== null
  const rows = !scopes.user && !project ? [] : await db.select({
    mount: workspaceFiles.mount,
    relativePath: workspaceFiles.relative_path,
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

  async function scope(mount: 'memory/user' | 'memory/project'): Promise<ScopeCatalog> {
    const own = rows.filter(row => row.mount === mount)
    const hasProfile = own.some(row => row.relativePath === 'profile.md')
    const text = hasProfile ? await readFile(mount, 'profile.md') : null
    return {
      profile: text === null ? null : { path: `/${mount}/profile.md`, text },
      // A profile that could not be read still gets its line, so the model knows it is there.
      entries: own
        .filter(row => text === null || row.relativePath !== 'profile.md')
        .map(row => ({ path: `/${row.mount}/${row.relativePath}`, category: memoryCategory(row.relativePath), description: row.description })),
    }
  }

  return {
    user: scopes.user ? await scope('memory/user') : 'off',
    project: projectId === null ? null : project ? await scope('memory/project') : 'off',
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
export async function memoryPreamble(input: {
  db: DB
  userId: number
  conversationId: number
  projectId: number | null
  scopes: MemoryScopes
  readFile: ReadMemoryFile
}): Promise<string> {
  const { db, userId, conversationId, projectId, scopes, readFile } = input
  const key = scopesKey(scopes)
  const stored = await readSnapshot(db, conversationId)
  if (stored && stored.project_id === projectId && stored.scopes === key) return stored.text

  const catalog = await loadCatalog(db, userId, projectId, scopes, readFile)
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
