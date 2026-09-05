import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { DB } from '../../db/client'
import { attachments, messages, models, providers, sessions, users } from '../../db/schema'
import type { AttachmentRow, MessageRow, ModelRow, ProviderRow, SessionRow, UserRow } from '../../db/schema'
import type { Message, MessageStatus, PersistedStatus, Usage, UserSettings } from '@/shared/models'
import type { Part } from '@/shared/parts'

/** Row → wire DTO. Persisted rows only carry the persisted statuses; live ones pass `status` in. */
export function toMessage(row: MessageRow, status: MessageStatus = row.status): Message {
  return { ...row, status }
}

export async function listSessions(db: DB, userId: number): Promise<SessionRow[]> {
  return db.select().from(sessions).where(and(eq(sessions.user_id, userId), isNull(sessions.archived_at))).orderBy(desc(sessions.updated_at))
}

export async function getSession(db: DB, id: number): Promise<SessionRow | undefined> {
  return db.query.sessions.findFirst({ where: eq(sessions.id, id) })
}

export async function createSession(db: DB, input: { user_id: number; title: string; provider_id: number | null; model_id: string | null }): Promise<SessionRow> {
  const now = Date.now()
  const [row] = await db.insert(sessions).values({ ...input, head_message_id: null, system_prompt: null, params: null, created_at: now, updated_at: now, archived_at: null }).returning()
  return row!
}

export async function updateSession(
  db: DB,
  id: number,
  patch: Partial<Pick<SessionRow, 'title' | 'provider_id' | 'model_id' | 'system_prompt' | 'params' | 'head_message_id'>>,
): Promise<SessionRow> {
  const [row] = await db.update(sessions).set({ ...patch, updated_at: Date.now() }).where(eq(sessions.id, id)).returning()
  if (!row) throw new Error(`session ${id} not found`)
  return row
}

export async function deleteSession(db: DB, id: number): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id)) // messages cascade
}

export async function listMessages(db: DB, sessionId: number): Promise<MessageRow[]> {
  return db.select().from(messages).where(eq(messages.session_id, sessionId)).orderBy(messages.seq)
}

export async function getMessage(db: DB, id: number): Promise<MessageRow | undefined> {
  return db.query.messages.findFirst({ where: eq(messages.id, id) })
}

export async function insertMessage(db: DB, row: Omit<MessageRow, 'id'>): Promise<MessageRow> {
  const [inserted] = await db.insert(messages).values(row).returning()
  return inserted!
}

export async function finalizeMessage(
  db: DB,
  id: number,
  patch: { parts: Part[]; usage: Usage | null; status: PersistedStatus; error: string | null },
): Promise<void> {
  await db.update(messages).set(patch).where(eq(messages.id, id))
}

export async function maxSeq(db: DB, sessionId: number): Promise<number> {
  const [row] = await db.select({ max: sql<number>`coalesce(max(${messages.seq}), 0)` }).from(messages).where(eq(messages.session_id, sessionId))
  return row?.max ?? 0
}

export async function getUser(db: DB, id: number): Promise<UserRow | undefined> {
  return db.query.users.findFirst({ where: eq(users.id, id) })
}

export async function updateUserSettings(db: DB, id: number, settings: UserSettings): Promise<UserRow> {
  const [row] = await db.update(users).set({ settings }).where(eq(users.id, id)).returning()
  if (!row) throw new Error(`user ${id} not found`)
  return row
}

export async function getProvider(db: DB, id: number): Promise<ProviderRow | undefined> {
  return db.query.providers.findFirst({ where: eq(providers.id, id) })
}

export async function getModel(db: DB, providerId: number, modelId: string): Promise<ModelRow | undefined> {
  return db.query.models.findFirst({ where: and(eq(models.provider_id, providerId), eq(models.model_id, modelId)) })
}

export async function getAttachment(db: DB, id: number): Promise<AttachmentRow | undefined> {
  return db.query.attachments.findFirst({ where: eq(attachments.id, id) })
}
