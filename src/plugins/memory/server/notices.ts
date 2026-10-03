import { and, eq, inArray } from 'drizzle-orm'
import type { DB } from '@/server/db/client'
import { memoryNotes, memorySnapshots, type KnownMemoryFile } from '@/server/db/schema'
import type { Message } from '@/shared/models'
import type { MemoryScopes } from '../shared'
import { inlineBlock, loadKnown, readSnapshot, type InlineCategory, type ReadMemoryFile } from './catalog'

type Known = Record<string, KnownMemoryFile>

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

export function isEmpty(changes: MemoryChanges): boolean {
  return changes.added.length + changes.updated.length + changes.moved.length + changes.removed.length === 0
}

/** The files that travel whole in the catalog travel whole here too, when they change. */
function inlineCategoryOf(path: string): InlineCategory | null {
  if (/^\/memory\/(user|project)\/profile\.md$/.test(path)) return 'profile'
  if (/^\/memory\/(user|project)\/preferences\.md$/.test(path)) return 'preferences'
  return null
}

const line = (verb: string, file: KnownMemoryFile) => (
  file.description === null ? `- ${verb} ${file.path}` : `- ${verb} ${file.path} — ${file.description}`
)

/** The reminder text. `texts` holds the current contents of changed profiles and preferences. */
export function renderNotice(changes: MemoryChanges, texts: ReadonlyMap<string, string>): string {
  const lines = ['Memory changed since you last looked:']
  const withText = (verb: string, file: KnownMemoryFile) => {
    lines.push(line(verb, file))
    const category = inlineCategoryOf(file.path)
    const text = texts.get(file.path)
    if (category !== null && text !== undefined) lines.push(inlineBlock({ category, path: file.path, text }))
  }
  for (const file of changes.added) withText('new', file)
  for (const file of changes.updated) withText('updated', file)
  for (const { from, to } of changes.moved) lines.push(`- moved ${from} → ${to}`)
  for (const path of changes.removed) lines.push(`- removed ${path}`)
  return lines.join('\n')
}

async function setKnown(db: DB, conversationId: number, known: Known): Promise<void> {
  await db.update(memorySnapshots).set({ known }).where(eq(memorySnapshots.conversation_id, conversationId))
}

/**
 * The reminders a turn carries: those stored for user messages on its path, and a new one for the
 * message it answers when memory changed elsewhere since the conversation last knew it.
 *
 * Only a turn that ends at a user message gets a new one, and only once: regenerating that message
 * replays the stored reminder rather than diffing again, and a continuation (an answered question,
 * a task's result) leaves it for the next thing the person says.
 */
export async function memoryNotices(input: {
  db: DB
  userId: number
  conversationId: number
  projectId: number | null
  scopes: MemoryScopes
  path: readonly Message[]
  /** The snapshot was rendered this turn, with a fresh `known`: nothing can have changed since. */
  rendered: boolean
  readFile: ReadMemoryFile
}): Promise<Array<{ messageId: number, text: string }>> {
  const { db, userId, conversationId, projectId, scopes, path, rendered, readFile } = input
  const userIds = path.filter(message => message.role === 'user').map(message => message.id)
  const stored = userIds.length === 0 ? [] : await db.select().from(memoryNotes).where(and(
    eq(memoryNotes.conversation_id, conversationId),
    inArray(memoryNotes.message_id, userIds),
  ))
  const notes = stored.map(note => ({ messageId: note.message_id, text: note.text }))

  const leaf = path.at(-1)
  if (rendered || leaf === undefined || leaf.role !== 'user' || stored.some(note => note.message_id === leaf.id)) {
    return order(notes, userIds)
  }

  const snapshot = await readSnapshot(db, conversationId)
  if (!snapshot) return order(notes, userIds)
  const current = await loadKnown(db, userId, projectId, scopes)
  // A snapshot from before this was tracked starts from what is there now, not from nothing.
  if (snapshot.known === null) {
    await setKnown(db, conversationId, current)
    return order(notes, userIds)
  }
  const changes = diffKnown(snapshot.known, current)
  if (isEmpty(changes)) return order(notes, userIds)

  const texts = new Map<string, string>()
  for (const file of [...changes.added, ...changes.updated]) {
    if (inlineCategoryOf(file.path) === null) continue
    const mount = file.path.startsWith('/memory/user/') ? 'memory/user' : 'memory/project'
    const text = await readFile(mount, file.path.slice(`/${mount}/`.length))
    if (text !== null) texts.set(file.path, text)
  }
  await db.insert(memoryNotes).values({ message_id: leaf.id, conversation_id: conversationId, text: renderNotice(changes, texts) })
    .onConflictDoNothing()
  await setKnown(db, conversationId, current)
  const [kept] = await db.select().from(memoryNotes).where(eq(memoryNotes.message_id, leaf.id)).limit(1)
  return order(kept ? [...notes, { messageId: kept.message_id, text: kept.text }] : notes, userIds)
}

/** Path order, so the same history always yields the same notes in the same order. */
function order(notes: Array<{ messageId: number, text: string }>, userIds: readonly number[]) {
  const rank = new Map(userIds.map((id, index) => [id, index]))
  return [...notes].sort((a, b) => rank.get(a.messageId)! - rank.get(b.messageId)!)
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
  projectId: number | null
  scopes: MemoryScopes
  touched: ReadonlySet<string>
}): Promise<void> {
  const { db, userId, conversationId, projectId, scopes, touched } = input
  if (touched.size === 0) return
  const snapshot = await readSnapshot(db, conversationId)
  if (!snapshot?.known) return
  const current = await loadKnown(db, userId, projectId, scopes)
  const known: Known = { ...snapshot.known }
  let changed = false
  for (const id of new Set([...Object.keys(known), ...Object.keys(current)])) {
    const was = known[id]
    const now = current[id]
    const mine = (was !== undefined && touched.has(was.path)) || (now !== undefined && touched.has(now.path))
    if (!mine) continue
    if (now === undefined) delete known[id]
    else known[id] = now
    changed = true
  }
  if (changed) await setKnown(db, conversationId, known)
}

/** A fork's messages are copies with new ids; its reminders move onto them. */
export async function copyNotes(db: DB, sourceConversationId: number, targetConversationId: number, messageIds: ReadonlyMap<number, number>): Promise<void> {
  const notes = await db.select().from(memoryNotes).where(eq(memoryNotes.conversation_id, sourceConversationId))
  const copies = notes
    .filter(note => messageIds.has(note.message_id))
    .map(note => ({ message_id: messageIds.get(note.message_id)!, conversation_id: targetConversationId, text: note.text }))
  if (copies.length > 0) await db.insert(memoryNotes).values(copies).onConflictDoNothing()
}
