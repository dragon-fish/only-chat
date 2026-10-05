import { and, desc, eq, isNull, or } from 'drizzle-orm'
import type { DB } from '@/server/db/client'
import { memories, workspaceFiles, type KnownMemoryFile } from '@/server/db/schema'
import { MEMORY_SAVE_TOOL_ID } from '@/shared/plugins'
import { MEMORY_CATEGORIES, MEMORY_LAYOUT, memoryCategory, type MemoryCategory, type MemoryScopes } from '../shared'

/** One line of the catalog. A file nobody described has no description. */
export interface CatalogEntry {
  path: string
  /** Null for a file outside the layout. */
  category: MemoryCategory | null
  description: string | null
}

/** A file that travels whole instead of as a line: what it is, where it lives, what it says. */
export interface InlineFile {
  category: InlineCategory
  path: string
  text: string
}

/** One open layer: its profile and preferences in full when it has them, and a line for every other file. */
export interface ScopeCatalog {
  inline: readonly InlineFile[]
  entries: readonly CatalogEntry[]
}

/** A layer this conversation does not use: said once, so the model neither reads nor saves there. */
export type ClosedScope = 'off'

/** Per scope. Past it the catalog says how many more there are and how to list them. */
export const CATALOG_LIMIT = 200

/**
 * The two single files apply to every turn, so they travel whole rather than as a line to follow —
 * each only up to this many characters. Past it the model is told to read the rest and shorten it.
 */
export const INLINE_LIMIT = 4000

/** Profile first, then preferences: who the user is reads before how to answer them. */
const INLINE = [
  { category: 'profile', relativePath: 'profile.md' },
  { category: 'preferences', relativePath: 'preferences.md' },
] as const
export type InlineCategory = (typeof INLINE)[number]['category']

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

export function inlineBlock(file: InlineFile): string {
  const text = file.text.length > INLINE_LIMIT
    ? `${file.text.slice(0, INLINE_LIMIT)}\n[Cut here: read_file the rest, and shorten the file.]`
    : file.text
  return `<${file.category} path="${file.path}">\n${text.trimEnd()}\n</${file.category}>`
}

/** One layer as the catalog shows it; also what a reminder carries for a layer that just opened. */
export function scopeBlock(name: 'user' | 'project', mount: string, scope: ScopeCatalog | ClosedScope): string {
  if (scope === 'off') return [`<scope name="${name}">`, CLOSED_NOTE[name]!, '</scope>'].join('\n')
  const sorted = ORDER.flatMap(category => scope.entries.filter(entry => entry.category === category))
  const lines = sorted.slice(0, CATALOG_LIMIT).map(line)
  if (sorted.length > CATALOG_LIMIT) lines.push(`… and ${sorted.length - CATALOG_LIMIT} more: list_files /${mount}`)
  const body = [...scope.inline.map(inlineBlock), ...lines]
  return [`<scope name="${name}">`, ...(body.length > 0 ? body : ['(empty)']), '</scope>'].join('\n')
}

/**
 * The catalog the first memory turn of a conversation leads its user message with. It is stored on
 * that message and never rendered again; what changes later reaches the model as reminders.
 * `project` is null for a conversation outside any Project, which has no project scope at all
 * rather than an empty one; `'off'` is a layer this conversation has switched off.
 */
export function renderCatalog(user: ScopeCatalog | ClosedScope, project: ScopeCatalog | ClosedScope | null): string {
  return [
    '<memory-catalog>',
    'Your memory as of this message; later changes arrive as reminders on later messages. Read a file before relying on it.',
    // Project memory is the primary layer inside a Project, so it reads first.
    ...(project === null ? [] : [scopeBlock('project', 'memory/project', project)]),
    scopeBlock('user', 'memory/user', user),
    '</memory-catalog>',
  ].join('\n')
}

/** Reads one memory file's text, or null when it is gone or not text. */
export type ReadMemoryFile = (mount: 'memory/user' | 'memory/project', relativePath: string) => Promise<string | null>

/** Live files in the open memory mounts, newest first, with each layer's profile and preferences read in full. */
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
    const inline: InlineFile[] = []
    for (const { category, relativePath } of INLINE) {
      if (!own.some(row => row.relativePath === relativePath)) continue
      const text = await readFile(mount, relativePath)
      if (text !== null) inline.push({ category, path: `/${mount}/${relativePath}`, text })
    }
    const shown = new Set(inline.map(file => file.path))
    return {
      inline,
      // A single file that could not be read still gets its line, so the model knows it is there.
      entries: own
        .map(row => ({ path: `/${row.mount}/${row.relativePath}`, category: memoryCategory(row.relativePath), description: row.description }))
        .filter(entry => !shown.has(entry.path)),
    }
  }

  return {
    user: scopes.user ? await scope('memory/user') : 'off',
    project: projectId === null ? null : project ? await scope('memory/project') : 'off',
  }
}

/** Every live file in the open memory mounts as a conversation would know it, by file id. */
export async function loadKnown(db: DB, userId: number, projectId: number | null, scopes: MemoryScopes): Promise<Record<string, KnownMemoryFile>> {
  const project = scopes.project && projectId !== null
  if (!scopes.user && !project) return {}
  const rows = await db.select({
    id: workspaceFiles.id,
    mount: workspaceFiles.mount,
    relativePath: workspaceFiles.relative_path,
    version: workspaceFiles.current_version,
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
  return Object.fromEntries(rows.map(row => [String(row.id), {
    path: `/${row.mount}/${row.relativePath}`, version: row.version, description: row.description,
  }]))
}

/** How a snapshot records which layers were open when it was rendered. */
export function scopesKey(scopes: MemoryScopes): string {
  return [scopes.user ? 'user' : null, scopes.project ? 'project' : null].filter(Boolean).join(',')
}
