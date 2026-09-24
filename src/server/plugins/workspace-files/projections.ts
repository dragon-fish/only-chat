import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import type { DB } from '../../db/client'
import { artifactRuns, artifacts, attachments, conversations, messages } from '../../db/schema'
import type { Part } from '@/shared/parts'
import { parseWorkspacePath, type ProjectedMount } from './path'

/** One image a projected mount shows. Derived on every read; nothing about it is stored. */
export interface ProjectedEntry {
  path: string
  attachmentId: number
  mime: string
  size: number
  width: number | null
  height: number | null
  createdAt: number
}

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

export function imageExtension(mime: string): string {
  return EXTENSIONS[mime] ?? 'bin'
}

/** An image a run produced. Named by artifact id: task notifications already hand the model these paths. */
export function artifactPath(artifactId: number, mime: string): string {
  return `/artifacts/${artifactId}.${imageExtension(mime)}`
}

/** An image the chat model produced inline, which has no artifact row, only an attachment. */
export function generatedPath(attachmentId: number, mime: string): string {
  return `/artifacts/msg-${attachmentId}.${imageExtension(mime)}`
}

export function uploadPath(attachmentId: number, mime: string): string {
  return `/uploads/${attachmentId}.${imageExtension(mime)}`
}

/** Messages of a conversation this user owns; an empty list for anyone else's. */
async function ownedMessageParts(db: DB, userId: number, conversationId: number, role: 'user' | 'assistant') {
  const rows = await db.select({ parts: messages.parts, createdAt: messages.created_at }).from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversation_id))
    .where(and(eq(messages.conversation_id, conversationId), eq(conversations.user_id, userId), eq(messages.role, role)))
    .orderBy(asc(messages.seq))
  return rows.map(row => ({ parts: row.parts as Part[], createdAt: row.createdAt }))
}

async function attachmentEntries(db: DB, userId: number, found: Array<{ attachmentId: number, createdAt: number }>, pathOf: (attachmentId: number, mime: string) => string): Promise<ProjectedEntry[]> {
  if (found.length === 0) return []
  const rows = await db.select().from(attachments)
    .where(and(eq(attachments.user_id, userId), inArray(attachments.id, [...new Set(found.map(item => item.attachmentId))])))
  const byId = new Map(rows.map(row => [row.id, row]))
  const seen = new Set<number>()
  const entries: ProjectedEntry[] = []
  for (const { attachmentId, createdAt } of found) {
    const row = byId.get(attachmentId)
    if (!row || seen.has(attachmentId)) continue
    seen.add(attachmentId)
    entries.push({ path: pathOf(row.id, row.mime), attachmentId: row.id, mime: row.mime, size: row.size, width: row.width, height: row.height, createdAt })
  }
  return entries
}

export async function listProjected(db: DB, userId: number, conversationId: number, mount: ProjectedMount): Promise<ProjectedEntry[]> {
  if (mount === 'uploads') {
    const found = (await ownedMessageParts(db, userId, conversationId, 'user')).flatMap(message =>
      message.parts.flatMap(part => (part.type === 'image' ? [{ attachmentId: part.attachment_id, createdAt: message.createdAt }] : [])))
    return attachmentEntries(db, userId, found, uploadPath)
  }

  const runOutputs = await db.select({ artifact: artifacts, attachment: attachments }).from(artifacts)
    .innerJoin(artifactRuns, eq(artifactRuns.id, artifacts.run_id))
    .innerJoin(attachments, eq(attachments.id, artifacts.attachment_id))
    .where(and(eq(artifacts.user_id, userId), eq(artifactRuns.conversation_id, conversationId), isNull(artifacts.deleted_at)))
    .orderBy(asc(artifacts.id))
  // Parts carrying an artifact id belong to a run and are listed above; the rest came from the chat model itself.
  const inline = (await ownedMessageParts(db, userId, conversationId, 'assistant')).flatMap(message =>
    message.parts.flatMap(part => (part.type === 'image' && part.artifact_id === undefined ? [{ attachmentId: part.attachment_id, createdAt: message.createdAt }] : [])))
  return [
    ...runOutputs.map(({ artifact, attachment }): ProjectedEntry => ({
      path: artifactPath(artifact.id, attachment.mime), attachmentId: attachment.id, mime: attachment.mime,
      size: attachment.size, width: attachment.width, height: attachment.height, createdAt: artifact.created_at,
    })),
    ...await attachmentEntries(db, userId, inline, generatedPath),
  ]
}

/** The image a projected path names in this conversation, or null — never someone else's. */
export async function resolveProjected(db: DB, userId: number, conversationId: number, path: string): Promise<ProjectedEntry | null> {
  const parsed = parseWorkspacePath(path)
  if (!parsed.ok) return null
  const { mount, relativePath } = parsed.value
  if ((mount !== 'artifacts' && mount !== 'uploads') || relativePath === '' || relativePath.includes('/')) return null
  const entries = await listProjected(db, userId, conversationId, mount)
  return entries.find(entry => entry.path === path) ?? null
}
