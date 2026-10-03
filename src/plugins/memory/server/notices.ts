import { eq } from 'drizzle-orm'
import type { DB } from '@/server/db/client'
import { memoryState, type KnownMemoryFile } from '@/server/db/schema'
import type { Message } from '@/shared/models'
import { MEMORY_PLUGIN_ID, type MemoryScopes } from '../shared'
import {
  inlineBlock, loadCatalog, loadKnown, renderCatalog, scopeBlock, scopesKey,
  type InlineCategory, type ReadMemoryFile, type ScopeCatalog,
} from './catalog'

type Known = Record<string, KnownMemoryFile>

/** What a conversation was last told: which Project, which layers, which files. */
export interface MemoryState {
  projectId: number | null
  scopes: MemoryScopes
  known: Known
}

export async function readState(db: DB, conversationId: number): Promise<MemoryState | null> {
  const [row] = await db.select().from(memoryState).where(eq(memoryState.conversation_id, conversationId)).limit(1)
  if (!row) return null
  const open = new Set(row.scopes.split(','))
  return { projectId: row.project_id, scopes: { user: open.has('user'), project: open.has('project') }, known: row.known }
}

export async function writeState(db: DB, conversationId: number, state: MemoryState): Promise<void> {
  const values = { project_id: state.projectId, scopes: scopesKey(state.scopes), known: state.known, updated_at: Date.now() }
  await db.insert(memoryState).values({ conversation_id: conversationId, ...values })
    .onConflictDoUpdate({ target: memoryState.conversation_id, set: values })
}

/** A fork replays the source's messages, catalog and reminders included, so it knows what they knew. */
export async function copyState(db: DB, sourceConversationId: number, targetConversationId: number): Promise<void> {
  const state = await readState(db, sourceConversationId)
  if (state) await writeState(db, targetConversationId, state)
}

/** What changed between two views of the memory files, each list sorted by path. */
export interface MemoryChanges {
  added: KnownMemoryFile[]
  updated: KnownMemoryFile[]
  moved: Array<{ from: string, to: string }>
  removed: string[]
}

/** Matched by file id, so a move is a move rather than one file gone and another new. */
export function diffKnown(known: Known, current: Known): MemoryChanges {
  const changes: MemoryChanges = { added: [], updated: [], moved: [], removed: [] }
  for (const [id, now] of Object.entries(current)) {
    const was = known[id]
    if (was === undefined) { changes.added.push(now); continue }
    if (was.path !== now.path) changes.moved.push({ from: was.path, to: now.path })
    if (was.version !== now.version || was.description !== now.description) changes.updated.push(now)
  }
  for (const [id, was] of Object.entries(known)) if (current[id] === undefined) changes.removed.push(was.path)
  const byPath = (a: KnownMemoryFile, b: KnownMemoryFile) => a.path.localeCompare(b.path)
  changes.added.sort(byPath)
  changes.updated.sort(byPath)
  changes.moved.sort((a, b) => a.to.localeCompare(b.to))
  changes.removed.sort((a, b) => a.localeCompare(b))
  return changes
}

/** The files that travel whole in the catalog travel whole here too, when they change. */
function inlineCategoryOf(path: string): InlineCategory | null {
  if (/^\/memory\/(user|project)\/profile\.md$/.test(path)) return 'profile'
  if (/^\/memory\/(user|project)\/preferences\.md$/.test(path)) return 'preferences'
  return null
}

/** One line per changed file. `texts` holds the current contents of changed profiles and preferences. */
export function changeLines(changes: MemoryChanges, texts: ReadonlyMap<string, string>): string[] {
  const lines: string[] = []
  const withText = (verb: string, file: KnownMemoryFile) => {
    lines.push(file.description === null ? `- ${verb} ${file.path}` : `- ${verb} ${file.path} — ${file.description}`)
    const category = inlineCategoryOf(file.path)
    const text = texts.get(file.path)
    if (category !== null && text !== undefined) lines.push(inlineBlock({ category, path: file.path, text }))
  }
  for (const file of changes.added) withText('new', file)
  for (const file of changes.updated) withText('updated', file)
  for (const { from, to } of changes.moved) lines.push(`- moved ${from} → ${to}`)
  for (const path of changes.removed) lines.push(`- removed ${path}`)
  return lines
}

export const REMINDER_HEADING = 'Memory changed since you last looked:'

const OFF_NOW = {
  user: 'User memory is now off in this conversation: do not read or save anything under /memory/user.',
  project: 'Project memory is now off in this conversation: do not read or save anything under /memory/project.',
}

/**
 * The notes a turn adds for memory, all on the user message it answers: the full catalog, ahead of
 * what the person said, the first time memory is on along this path; afterwards a reminder at the
 * end, when something changed since the conversation was last told.
 *
 * Nothing is added to a message that already carries a memory note — a regenerated reply keeps
 * what it was sent — nor for a turn that does not answer a user message (an answered question, a
 * task's result), which leaves it for the next thing the person says.
 */
export async function memoryTurnNotes(input: {
  db: DB
  userId: number
  conversationId: number
  projectId: number | null
  scopes: MemoryScopes
  path: readonly Message[]
  readFile: ReadMemoryFile
}): Promise<Array<{ text: string, at?: 'start' }>> {
  const { db, userId, conversationId, projectId, scopes, path, readFile } = input
  const leaf = path.at(-1)
  if (leaf === undefined || leaf.role !== 'user') return []
  const mine = (message: Message) => message.notes?.some(note => note.plugin === MEMORY_PLUGIN_ID) === true
  if (mine(leaf)) return []

  const current: MemoryState = { projectId, scopes, known: await loadKnown(db, userId, projectId, scopes) }
  const hasCatalog = path.some(message => message.notes?.some(note => note.plugin === MEMORY_PLUGIN_ID && note.at === 'start'))
  const before = await readState(db, conversationId)
  if (!hasCatalog || before === null) {
    const catalog = await loadCatalog(db, userId, projectId, scopes, readFile)
    await writeState(db, conversationId, current)
    return [{ text: renderCatalog(catalog.user, catalog.project), at: 'start' }]
  }

  const text = await reminder(db, userId, before, current, readFile)
  if (text === null) return []
  await writeState(db, conversationId, current)
  return [{ text }]
}

/** Everything that differs between what the conversation was told and what is there now, or null. */
async function reminder(db: DB, userId: number, before: MemoryState, after: MemoryState, readFile: ReadMemoryFile): Promise<string | null> {
  const lines: string[] = []
  /** Renders one layer that has just opened, as the catalog would have shown it. */
  const opened = async (layer: 'user' | 'project') => {
    const catalog = await loadCatalog(db, userId, after.projectId, { user: layer === 'user', project: layer === 'project' }, readFile)
    return scopeBlock(layer, `memory/${layer}`, (layer === 'user' ? catalog.user : catalog.project) as ScopeCatalog)
  }

  if (before.scopes.user && !after.scopes.user) lines.push(OFF_NOW.user)
  if (!before.scopes.user && after.scopes.user) lines.push('User memory is now on in this conversation:', await opened('user'))

  // A Project's memory belongs to that Project: moving the conversation is the old layer closing
  // and a new one opening, never a list of file changes.
  const projectBefore = before.scopes.project ? before.projectId : null
  const projectAfter = after.scopes.project ? after.projectId : null
  if (projectBefore !== projectAfter) {
    if (projectAfter === null) lines.push(OFF_NOW.project)
    else {
      lines.push(projectBefore === null
        ? 'Project memory is now on in this conversation:'
        : 'This conversation is now in a different Project, with project memory of its own:')
      lines.push(await opened('project'))
    }
  }

  // File changes only within layers that stayed open: anything else was just said above.
  const steady = (path: string) => (path.startsWith('/memory/user/')
    ? before.scopes.user && after.scopes.user
    : projectBefore !== null && projectBefore === projectAfter)
  const within = (known: Known) => Object.fromEntries(Object.entries(known).filter(([, file]) => steady(file.path)))
  const changes = diffKnown(within(before.known), within(after.known))
  const texts = new Map<string, string>()
  for (const file of [...changes.added, ...changes.updated]) {
    if (inlineCategoryOf(file.path) === null) continue
    const mount = file.path.startsWith('/memory/user/') ? 'memory/user' : 'memory/project'
    const text = await readFile(mount, file.path.slice(`/${mount}/`.length))
    if (text !== null) texts.set(file.path, text)
  }
  lines.push(...changeLines(changes, texts))
  return lines.length === 0 ? null : [REMINDER_HEADING, ...lines].join('\n')
}

/**
 * At the end of a turn, what it changed itself becomes known: the model already saw those changes
 * in its own tool results. Anything else that changed meanwhile stays unknown, for the next turn's
 * reminder.
 */
export async function absorbOwnChanges(input: {
  db: DB
  userId: number
  conversationId: number
  touched: ReadonlySet<string>
}): Promise<void> {
  const { db, userId, conversationId, touched } = input
  if (touched.size === 0) return
  const state = await readState(db, conversationId)
  if (!state) return
  const current = await loadKnown(db, userId, state.projectId, state.scopes)
  const known: Known = { ...state.known }
  let changed = false
  for (const id of new Set([...Object.keys(known), ...Object.keys(current)])) {
    const was = known[id]
    const now = current[id]
    const own = (was !== undefined && touched.has(was.path)) || (now !== undefined && touched.has(now.path))
    if (!own) continue
    if (now === undefined) delete known[id]
    else known[id] = now
    changed = true
  }
  if (changed) await writeState(db, conversationId, { ...state, known })
}
