import { and, desc, eq, gt, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import type { ScopedFilesClient } from '../llm/files/types'
import type { DB } from '../../db/client'
import { attachmentProviderFiles, attachments, messages, models, providerInterfaces, providers, sessions, users } from '../../db/schema'
import type {
  AttachmentProviderFileRow, AttachmentRow, MessageRow, ModelRow, ProviderInterfaceRow, ProviderRow, SessionRow, UserRow,
} from '../../db/schema'
import type { Message, MessageStatus, PersistedStatus, SessionParams, Usage, UserSettings } from '@/shared/models'
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

/**
 * Creates a session from the draft the first `send` carried (spec §5.2). `provider_id`/`model_id`
 * are the session's *override* — never the model used for that first generation, or the session
 * would stop inheriting from its Project on every later turn.
 */
export async function createSession(db: DB, input: {
  user_id: number
  title: string
  provider_id: number | null
  model_id: string | null
  project_id?: number | null
  system_prompt?: string | null
  params?: SessionParams | null
}): Promise<SessionRow> {
  const now = Date.now()
  const [row] = await db.insert(sessions).values({
    user_id: input.user_id,
    title: input.title,
    project_id: input.project_id ?? null,
    provider_id: input.provider_id,
    model_id: input.model_id,
    system_prompt: input.system_prompt ?? null,
    params: input.params ?? null,
    head_message_id: null,
    created_at: now,
    updated_at: now,
    archived_at: null,
  }).returning()
  return row!
}

export async function updateSession(
  db: DB,
  id: number,
  patch: Partial<Pick<SessionRow, 'title' | 'project_id' | 'provider_id' | 'model_id' | 'system_prompt' | 'params' | 'head_message_id'>>,
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

/**
 * The model the session last generated with. `edit` carries no model of its own, and
 * `sessions.provider_id` is now the user's explicit override rather than a sticky record of the
 * last generation, so the answer has to come from the messages themselves.
 */
export async function lastGenerationModel(db: DB, sessionId: number): Promise<{ provider_id: number; model_id: string } | undefined> {
  const [row] = await db.select({ provider_id: messages.provider_id, model_id: messages.model_id })
    .from(messages)
    .where(and(eq(messages.session_id, sessionId), isNotNull(messages.provider_id), isNotNull(messages.model_id)))
    .orderBy(desc(messages.seq))
    .limit(1)
  if (!row || row.provider_id === null || row.model_id === null) return undefined
  return { provider_id: row.provider_id, model_id: row.model_id }
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

export async function getProviderInterface(db: DB, id: number): Promise<ProviderInterfaceRow | undefined> {
  return db.query.providerInterfaces.findFirst({ where: eq(providerInterfaces.id, id) })
}

export async function getAttachment(db: DB, id: number): Promise<AttachmentRow | undefined> {
  return db.query.attachments.findFirst({ where: eq(attachments.id, id) })
}

export type ProviderFileScope = Pick<ScopedFilesClient, 'family' | 'baseURL' | 'credentialVersion'> & { providerId: number }

/** Match the Files endpoint and credentials, retaining expired references for remote cleanup. */
export async function findReusableProviderFile(db: DB, scope: ProviderFileScope, attachmentId: number, now: number): Promise<AttachmentProviderFileRow | undefined> {
  return db.query.attachmentProviderFiles.findFirst({
    where: and(
      eq(attachmentProviderFiles.attachment_id, attachmentId),
      eq(attachmentProviderFiles.provider_id, scope.providerId),
      eq(attachmentProviderFiles.credential_version, scope.credentialVersion),
      eq(attachmentProviderFiles.file_family, scope.family),
      eq(attachmentProviderFiles.base_url, scope.baseURL),
      gt(attachmentProviderFiles.expires_at, now),
    ),
    orderBy: [desc(attachmentProviderFiles.created_at), desc(attachmentProviderFiles.id)],
  })
}

/** Append each upload so older remote references remain available for cleanup. */
export async function insertProviderFile(db: DB, row: typeof attachmentProviderFiles.$inferInsert): Promise<void> {
  await db.insert(attachmentProviderFiles).values(row)
}

/**
 * The whole of the daily cron job (spec §5.7): local pointers that have lapsed are dropped, and the
 * remote copies are left for the provider to expire on the deadline the upload asked for. R2
 * originals are untouched — the next turn that needs one re-uploads it.
 */
export async function cleanupExpiredProviderFiles(db: DB, now: number): Promise<void> {
  await db.delete(attachmentProviderFiles).where(lte(attachmentProviderFiles.expires_at, now))
}
