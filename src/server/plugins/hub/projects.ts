import { and, desc, eq } from 'drizzle-orm'
import type { DB } from '../../db/client'
import { attachments, projects, conversations } from '../../db/schema'
import type { ProjectRow, ConversationRow } from '../../db/schema'

/** Every read and write is scoped to the owning user; D1 is the source of truth (spec §5.1). */

export async function listProjects(db: DB, userId: number): Promise<ProjectRow[]> {
  return db.select().from(projects).where(eq(projects.user_id, userId)).orderBy(desc(projects.updated_at))
}

export async function getProject(db: DB, id: number, userId: number): Promise<ProjectRow | undefined> {
  return db.query.projects.findFirst({ where: and(eq(projects.id, id), eq(projects.user_id, userId)) })
}

export async function createProject(
  db: DB,
  input: Pick<ProjectRow, 'user_id' | 'name'> & Partial<Pick<ProjectRow, 'icon_attachment_id' | 'system_prompt' | 'provider_id' | 'model_id' | 'params'>>,
): Promise<ProjectRow> {
  const now = Date.now()
  const [row] = await db.insert(projects).values({
    user_id: input.user_id,
    name: input.name,
    icon_attachment_id: input.icon_attachment_id ?? null,
    system_prompt: input.system_prompt ?? null,
    provider_id: input.provider_id ?? null,
    model_id: input.model_id ?? null,
    params: input.params ?? null,
    created_at: now,
    updated_at: now,
  }).returning()
  return row!
}

export async function updateProject(
  db: DB,
  id: number,
  userId: number,
  patch: Partial<Pick<ProjectRow, 'name' | 'icon_attachment_id' | 'system_prompt' | 'provider_id' | 'model_id' | 'params'>>,
): Promise<ProjectRow> {
  const [row] = await db.update(projects).set({ ...patch, updated_at: Date.now() })
    .where(and(eq(projects.id, id), eq(projects.user_id, userId))).returning()
  if (!row) throw new Error(`project ${id} not found`)
  return row
}

export async function validateProjectIcon(db: DB, userId: number, attachmentId: number | null): Promise<void> {
  if (attachmentId !== null) {
    const attachment = await db.query.attachments.findFirst({ where: and(eq(attachments.id, attachmentId), eq(attachments.user_id, userId)) })
    if (!attachment || !attachment.mime.startsWith('image/') || attachment.width !== 200 || attachment.height !== 200) throw new Error('project icon image must be 200×200')
  }
}

/**
 * Conversations keep existing: the `ON DELETE SET NULL` foreign key moves them back to Chats (spec §3.1).
 * Returns the deleted row, and throws when nothing matched, so a caller cannot mistake "not yours"
 * for "deleted" and broadcast `project.deleted` for a project it never touched.
 */
export async function deleteProject(db: DB, id: number, userId: number): Promise<ProjectRow> {
  const [row] = await db.delete(projects).where(and(eq(projects.id, id), eq(projects.user_id, userId))).returning()
  if (!row) throw new Error(`project ${id} not found`)
  return row
}

export async function listProjectConversations(db: DB, projectId: number, userId: number): Promise<ConversationRow[]> {
  return db.select().from(conversations)
    .where(and(eq(conversations.project_id, projectId), eq(conversations.user_id, userId)))
    .orderBy(desc(conversations.updated_at))
}
