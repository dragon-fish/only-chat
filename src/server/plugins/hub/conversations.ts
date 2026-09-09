import { and, desc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm'
import type { ScopedFilesClient } from '../llm/files/types'
import { normalizeFilesBaseURL } from '../llm/files/shared'
import type { DB } from '../../db/client'
import { attachmentProviderFiles, attachments, messages, models, providerInterfaces, providers, conversations, users } from '../../db/schema'
import type {
  AttachmentProviderFileRow, AttachmentRow, MessageRow, ModelRow, ProviderInterfaceRow, ProviderRow, ConversationRow, UserRow,
} from '../../db/schema'
import type { Message, MessageStatus, PersistedStatus, ConversationParams, Usage, UserSettings } from '@/shared/models'
import type { Part, ToolResultPart } from '@/shared/parts'

/** Row → wire DTO. Persisted rows only carry the persisted statuses; live ones pass `status` in. */
export function toMessage(row: MessageRow, status: MessageStatus = row.status): Message {
  return { ...row, status }
}

export async function listConversations(db: DB, userId: number): Promise<ConversationRow[]> {
  return db.select().from(conversations).where(and(eq(conversations.user_id, userId), isNull(conversations.archived_at))).orderBy(desc(conversations.updated_at))
}

export async function getConversation(db: DB, id: number): Promise<ConversationRow | undefined> {
  return db.query.conversations.findFirst({ where: eq(conversations.id, id) })
}

/**
 * Creates a conversation from the draft the first `send` carried (spec §5.2). `provider_id`/`model_id`
 * are the conversation's *override* — never the model used for that first generation, or the conversation
 * would stop inheriting from its Project on every later turn.
 */
export async function createConversation(db: DB, input: {
  user_id: number
  title: string
  provider_id: number | null
  model_id: string | null
  project_id?: number | null
  system_prompt?: string | null
  params?: ConversationParams | null
  tools?: string[]
}): Promise<ConversationRow> {
  const now = Date.now()
  const [row] = await db.insert(conversations).values({
    user_id: input.user_id,
    title: input.title,
    project_id: input.project_id ?? null,
    provider_id: input.provider_id,
    model_id: input.model_id,
    system_prompt: input.system_prompt ?? null,
    params: input.params ?? null,
    tools: input.tools ?? [],
    head_message_id: null,
    created_at: now,
    updated_at: now,
    archived_at: null,
  }).returning()
  return row!
}

export async function updateConversation(
  db: DB,
  id: number,
  patch: Partial<Pick<ConversationRow, 'title' | 'project_id' | 'provider_id' | 'model_id' | 'system_prompt' | 'params' | 'tools' | 'head_message_id'>>,
): Promise<ConversationRow> {
  const [row] = await db.update(conversations).set({ ...patch, updated_at: Date.now() }).where(eq(conversations.id, id)).returning()
  if (!row) throw new Error(`conversation ${id} not found`)
  return row
}

/** Moves a Conversation head only if it still equals the caller's observed parent. */
export async function compareAndSwapConversationHead(
  db: DB,
  id: number,
  expectedHead: number | null,
  nextHead: number,
): Promise<ConversationRow | undefined> {
  const expected = expectedHead === null ? isNull(conversations.head_message_id) : eq(conversations.head_message_id, expectedHead)
  const [row] = await db.update(conversations)
    .set({ head_message_id: nextHead, updated_at: Date.now() })
    .where(and(eq(conversations.id, id), expected))
    .returning()
  return row
}

export async function deleteConversation(db: DB, id: number): Promise<void> {
  await db.delete(conversations).where(eq(conversations.id, id)) // messages cascade
}

export async function forkConversation(db: DB, sourceConversationId: number, userId: number, headMessageId: number): Promise<ConversationRow> {
  const source = await db.query.conversations.findFirst({ where: and(eq(conversations.id, sourceConversationId), eq(conversations.user_id, userId)) })
  if (!source) throw new Error('conversation not found')
  const rows = await listMessages(db, source.id)
  const byId = new Map(rows.map(message => [message.id, message]))
  const path: MessageRow[] = []
  const seen = new Set<number>()
  let current = byId.get(headMessageId)
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    path.push(current)
    current = current.parent_id === null ? undefined : byId.get(current.parent_id)
  }
  if (path.length === 0 || path.at(-1)?.parent_id !== null) throw new Error('message not in conversation path')
  path.reverse()

  const target = await createConversation(db, {
    user_id: source.user_id, title: `${source.title} 副本`, project_id: source.project_id,
    provider_id: source.provider_id, model_id: source.model_id,
    system_prompt: source.system_prompt, params: source.params, tools: source.tools,
  })
  try {
    let parentId: number | null = null
    for (const [index, message] of path.entries()) {
      const { id: _id, conversation_id: _conversationId, parent_id: _parentId, seq: _seq, ...copy } = message
      const inserted = await insertMessage(db, { ...copy, conversation_id: target.id, parent_id: parentId, seq: index + 1 })
      parentId = inserted.id
    }
    return await updateConversation(db, target.id, { head_message_id: parentId })
  } catch (error) {
    await deleteConversation(db, target.id)
    throw error
  }
}

export async function listMessages(db: DB, conversationId: number): Promise<MessageRow[]> {
  return db.select().from(messages).where(eq(messages.conversation_id, conversationId)).orderBy(messages.seq)
}

export async function getMessage(db: DB, id: number): Promise<MessageRow | undefined> {
  return db.query.messages.findFirst({ where: eq(messages.id, id) })
}

export async function listAssistantChildren(db: DB, parentId: number): Promise<MessageRow[]> {
  return db.select().from(messages).where(and(eq(messages.parent_id, parentId), eq(messages.role, 'assistant'))).orderBy(messages.seq)
}

/**
 * Appends a terminal tool result with one SQLite statement. The call-id predicate is scoped to one
 * Message row, so retries neither scan the table nor create a second result.
 */
export async function appendToolResult(
  db: DB,
  messageId: number,
  conversationId: number,
  part: ToolResultPart,
): Promise<boolean> {
  const result = await db.$client.prepare(`
    UPDATE messages
       SET parts = json_insert(parts, '$[#]', json(?))
     WHERE id = ?
       AND conversation_id = ?
       AND role = 'assistant'
       AND status = 'done'
       AND NOT EXISTS (
         SELECT 1 FROM json_each(parts)
          WHERE json_extract(value, '$.type') = 'tool_result'
            AND json_extract(value, '$.call_id') = ?
       )
  `).bind(JSON.stringify(part), messageId, conversationId, part.call_id).run()
  return result.meta.changes === 1
}

/**
 * Replaces one current head's complete Parts snapshot. Both the old JSON and Conversation head are part
 * of the same SQLite compare-and-swap, so a concurrent answer and a stale send cannot both win.
 */
export async function replaceMessagePartsIfCurrentHead(
  db: DB,
  expected: MessageRow,
  nextParts: Part[],
): Promise<boolean> {
  const updated = await db.$client.prepare(`
    UPDATE messages
       SET parts = json(?)
     WHERE id = ?
       AND conversation_id = ?
       AND role = 'assistant'
       AND status = 'done'
       AND json(parts) = json(?)
       AND EXISTS (
         SELECT 1 FROM conversations WHERE id = ? AND head_message_id = ?
       )
    RETURNING id
  `).bind(
    JSON.stringify(nextParts), expected.id, expected.conversation_id, JSON.stringify(expected.parts),
    expected.conversation_id, expected.id,
  ).first<{ id: number }>()
  return updated?.id === expected.id
}

export async function insertMessage(db: DB, row: Omit<MessageRow, 'id'>): Promise<MessageRow> {
  const [inserted] = await db.insert(messages).values(row).returning()
  return inserted!
}

export async function deleteMessage(db: DB, id: number): Promise<void> {
  await db.delete(messages).where(eq(messages.id, id))
}

/** Deletes an unannounced shell only while no Conversation head references it. */
export async function deleteMessageIfUnreferenced(db: DB, id: number): Promise<boolean> {
  const deleted = await db.$client.prepare(`
    DELETE FROM messages
     WHERE id = ?
       AND NOT EXISTS (SELECT 1 FROM conversations WHERE head_message_id = ?)
    RETURNING id
  `).bind(id, id).first<{ id: number }>()
  return deleted?.id === id
}

/** Creates the sole assistant continuation for one tool-call parent with an atomic SQLite fence. */
export async function insertAssistantChildIfAbsent(
  db: DB,
  row: Omit<MessageRow, 'id'> & { role: 'assistant'; parent_id: number },
): Promise<MessageRow | undefined> {
  const inserted = await db.$client.prepare(`
    INSERT INTO messages (
      conversation_id, parent_id, seq, role, parts, provider_id, model_id, usage, status, error, created_at
    )
    SELECT ?, ?, ?, 'assistant', json(?), ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM messages WHERE parent_id = ? AND role = 'assistant'
     )
       AND EXISTS (
         SELECT 1 FROM conversations WHERE id = ? AND head_message_id = ?
       )
    RETURNING id
  `).bind(
    row.conversation_id, row.parent_id, row.seq, JSON.stringify(row.parts), row.provider_id, row.model_id,
    row.usage === null ? null : JSON.stringify(row.usage), row.status, row.error, row.created_at, row.parent_id,
    row.conversation_id, row.parent_id,
  ).first<{ id: number }>()
  return inserted ? getMessage(db, inserted.id) : undefined
}

export async function finalizeMessage(
  db: DB,
  id: number,
  patch: { parts: Part[]; usage: Usage | null; status: PersistedStatus; error: string | null },
): Promise<void> {
  await db.update(messages).set(patch).where(eq(messages.id, id))
}

/**
 * The model the conversation last generated with. `edit` carries no model of its own, and
 * `conversations.provider_id` is now the user's explicit override rather than a sticky record of the
 * last generation, so the answer has to come from the messages themselves.
 */
export async function lastGenerationModel(db: DB, conversationId: number): Promise<{ provider_id: number; model_id: string } | undefined> {
  const [row] = await db.select({ provider_id: messages.provider_id, model_id: messages.model_id })
    .from(messages)
    .where(and(eq(messages.conversation_id, conversationId), isNotNull(messages.provider_id), isNotNull(messages.model_id)))
    .orderBy(desc(messages.seq))
    .limit(1)
  if (!row || row.provider_id === null || row.model_id === null) return undefined
  return { provider_id: row.provider_id, model_id: row.model_id }
}

export async function maxSeq(db: DB, conversationId: number): Promise<number> {
  const [row] = await db.select({ max: sql<number>`coalesce(max(${messages.seq}), 0)` }).from(messages).where(eq(messages.conversation_id, conversationId))
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
  const baseURL = normalizeFilesBaseURL(scope.baseURL, scope.family)
  const where = and(
    eq(attachmentProviderFiles.attachment_id, attachmentId),
    eq(attachmentProviderFiles.provider_id, scope.providerId),
    eq(attachmentProviderFiles.credential_version, scope.credentialVersion),
    eq(attachmentProviderFiles.file_family, scope.family),
    gt(attachmentProviderFiles.expires_at, now),
  )
  // SQL migrations cannot parse URLs. Page within the reuse index's scope prefix so URL aliases
  // compete in upload order without loading unrelated attachments or accepting expired rows.
  let cursor: AttachmentProviderFileRow | undefined
  for (;;) {
    const rows = await db.select().from(attachmentProviderFiles).where(and(where, cursor
      ? sql`(${attachmentProviderFiles.created_at}, ${attachmentProviderFiles.id}) < (${cursor.created_at}, ${cursor.id})` : undefined))
      .orderBy(desc(attachmentProviderFiles.created_at), desc(attachmentProviderFiles.id)).limit(50)
    if (!rows.length) return undefined
    for (const row of rows) {
      let normalized: string
      try { normalized = normalizeFilesBaseURL(row.base_url, row.file_family) } catch { continue }
      if (normalized !== baseURL) continue
      if (row.base_url !== normalized) {
        await db.update(attachmentProviderFiles).set({ base_url: normalized }).where(eq(attachmentProviderFiles.id, row.id))
      }
      return { ...row, base_url: normalized }
    }
    cursor = rows.at(-1)!
  }
}

/** Append each upload so older remote references remain available for cleanup. */
export async function insertProviderFile(db: DB, row: typeof attachmentProviderFiles.$inferInsert): Promise<void> {
  await db.insert(attachmentProviderFiles).values({ ...row, base_url: normalizeFilesBaseURL(row.base_url, row.file_family) })
}
