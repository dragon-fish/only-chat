import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { ScopedFilesClient } from '../llm/files/types'
import { normalizeFilesBaseURL } from '../llm/files/shared'
import type { DB } from '../../db/client'
import { attachmentProviderFiles, attachments, messages, models, providerInterfaces, providers, conversations, users } from '../../db/schema'
import type {
  AttachmentProviderFileRow, AttachmentRow, MessageRow, ModelRow, ProviderInterfaceRow, ProviderRow, ConversationRow, UserRow,
} from '../../db/schema'
import type {
  Message, MessageStatus, PersistedStatus, ConversationParams, ConversationPluginSettings, Usage, UserSettings,
} from '@/shared/models'
import type { Part, ToolResultPart } from '@/shared/parts'

/** Row → wire DTO. Persisted rows only carry the persisted statuses; live ones pass `status` in. */
export function toMessage(row: MessageRow, status: MessageStatus = row.status): Message {
  return { ...row, status }
}

export async function listConversations(db: DB, userId: number, kind: 'chat' | 'image' = 'chat'): Promise<ConversationRow[]> {
  return db.select().from(conversations).where(and(
    eq(conversations.user_id, userId), eq(conversations.kind, kind), isNull(conversations.archived_at),
  )).orderBy(desc(conversations.updated_at))
}

export async function getConversation(db: DB, id: number, userId: number): Promise<ConversationRow | undefined> {
  return db.query.conversations.findFirst({ where: and(eq(conversations.id, id), eq(conversations.user_id, userId)) })
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
  tools_enabled?: boolean
  plugin_settings?: ConversationPluginSettings | null
  kind?: 'chat' | 'image'
  image_provider_id?: number | null
  image_model_id?: string | null
}): Promise<ConversationRow> {
  const now = Date.now()
  const [row] = await db.insert(conversations).values({
    user_id: input.user_id,
    title: input.title,
    kind: input.kind ?? 'chat',
    project_id: input.project_id ?? null,
    provider_id: input.provider_id,
    model_id: input.model_id,
    image_provider_id: input.image_provider_id ?? null,
    image_model_id: input.image_model_id ?? null,
    system_prompt: input.system_prompt ?? null,
    params: input.params ?? null,
    tools: input.tools ?? [],
    tools_enabled: input.tools_enabled ?? true,
    plugin_settings: input.plugin_settings ?? null,
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
  userId: number,
  patch: Partial<Pick<ConversationRow, 'title' | 'project_id' | 'provider_id' | 'model_id' | 'system_prompt' | 'params' | 'tools' | 'tools_enabled' | 'plugin_settings' | 'head_message_id'>>,
): Promise<ConversationRow> {
  const [row] = await db.update(conversations).set({ ...patch, updated_at: Date.now() }).where(and(eq(conversations.id, id), eq(conversations.user_id, userId))).returning()
  if (!row) throw new Error('conversation not found')
  return row
}

/**
 * Renames a conversation only if it still carries the title the caller saw.
 *
 * The service model takes seconds to answer and a rename takes one, so the two race. Whoever the
 * user is, their name wins: a suggestion that arrives late finds the title changed and does nothing.
 */
export async function renameIfTitleUnchanged(
  db: DB,
  id: number,
  userId: number,
  expectedTitle: string,
  nextTitle: string,
): Promise<ConversationRow | undefined> {
  const [row] = await db.update(conversations)
    .set({ title: nextTitle, updated_at: Date.now() })
    .where(and(eq(conversations.id, id), eq(conversations.user_id, userId), eq(conversations.title, expectedTitle)))
    .returning()
  return row
}

/** Moves a Conversation head only if it still equals the caller's observed parent. */
export async function compareAndSwapConversationHead(
  db: DB,
  id: number,
  userId: number,
  expectedHead: number | null,
  nextHead: number,
): Promise<ConversationRow | undefined> {
  const expected = expectedHead === null ? isNull(conversations.head_message_id) : eq(conversations.head_message_id, expectedHead)
  const [row] = await db.update(conversations)
    .set({ head_message_id: nextHead, updated_at: Date.now() })
    .where(and(eq(conversations.id, id), eq(conversations.user_id, userId), expected))
    .returning()
  return row
}

/**
 * Artifacts are deliberately left alone. An image outlives the conversation that asked for it: the
 * Gallery is where generated images are kept and deleted, and a conversation is not a folder they
 * live in. Do not reintroduce a cascade here — a fork, a retry or a branch would each make one
 * conversation's deletion destroy images another still shows.
 */
export async function deleteConversation(db: DB, id: number, userId: number): Promise<void> {
  const [row] = await db.delete(conversations).where(and(eq(conversations.id, id), eq(conversations.user_id, userId))).returning({ id: conversations.id })
  if (!row) throw new Error('conversation not found')
}

/**
 * What a fork produced, for whoever owns a table keyed on a conversation or a message.
 *
 * `messageIds` maps each copied source message to its counterpart in the fork. A subscriber given
 * only the two conversation ids cannot rebuild a row keyed on `message_id`, which is what
 * `artifact_links` is.
 */
export interface ConversationForked {
  userId: number
  sourceConversationId: number
  conversation: ConversationRow
  messageIds: ReadonlyMap<number, number>
}

/**
 * Copies a conversation up to one message. Everything else keyed on the source conversation belongs
 * to whoever owns that table and is announced through `onForked` instead — this function must not
 * learn what a workspace file or an Artifact is.
 *
 * `onForked` runs inside the rollback on purpose: a subscriber that throws takes the whole fork with
 * it, so a conversation whose messages arrived without their files never becomes visible.
 */
export async function forkConversation(
  db: DB,
  sourceConversationId: number,
  userId: number,
  headMessageId: number,
  onForked?: (payload: ConversationForked) => Promise<void>,
): Promise<ConversationRow> {
  const source = await db.query.conversations.findFirst({ where: and(eq(conversations.id, sourceConversationId), eq(conversations.user_id, userId)) })
  if (!source) throw new Error('conversation not found')
  const rows = await listMessages(db, source.id, userId)
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
    tools_enabled: source.tools_enabled, plugin_settings: source.plugin_settings,
  })
  try {
    let parentId: number | null = null
    const messageIds = new Map<number, number>()
    for (const [index, message] of path.entries()) {
      const { id: _id, conversation_id: _conversationId, parent_id: _parentId, seq: _seq, ...copy } = message
      const inserted = await insertMessage(db, userId, { ...copy, conversation_id: target.id, parent_id: parentId, seq: index + 1 })
      messageIds.set(message.id, inserted.id)
      parentId = inserted.id
    }
    const conversation = await updateConversation(db, target.id, userId, { head_message_id: parentId })
    await onForked?.({ userId, sourceConversationId: source.id, conversation, messageIds })
    return conversation
  } catch (error) {
    await deleteConversation(db, target.id, userId)
    throw error
  }
}

/** The words a title is made from: the conversation's opening message, as the user wrote it. */
export async function firstUserMessageText(db: DB, conversationId: number, userId: number): Promise<string> {
  const rows = await listMessages(db, conversationId, userId)
  const first = rows.find(row => row.role === 'user')
  if (!first) return ''
  return first.parts.find((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')?.text.trim() ?? ''
}

export async function listMessages(db: DB, conversationId: number, userId: number): Promise<MessageRow[]> {
  const rows = await db.select({ message: messages }).from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversation_id))
    .where(and(eq(messages.conversation_id, conversationId), eq(conversations.user_id, userId))).orderBy(messages.seq)
  return rows.map(row => row.message)
}

function ownedMessages(db: DB, userId: number) {
  return inArray(messages.conversation_id, db.select({ id: conversations.id }).from(conversations).where(eq(conversations.user_id, userId)))
}

export async function getMessage(db: DB, id: number, userId: number): Promise<MessageRow | undefined> {
  return db.query.messages.findFirst({ where: and(eq(messages.id, id), ownedMessages(db, userId)) })
}

export async function listAssistantChildren(db: DB, parentId: number, userId: number): Promise<MessageRow[]> {
  return db.select().from(messages).where(and(eq(messages.parent_id, parentId), eq(messages.role, 'assistant'), ownedMessages(db, userId))).orderBy(messages.seq)
}

/**
 * Appends a terminal tool result with one SQLite statement. The call-id predicate is scoped to one
 * Message row, so retries neither scan the table nor create a second result.
 */
export async function appendToolResult(
  db: DB,
  messageId: number,
  userId: number,
  conversationId: number,
  part: ToolResultPart,
): Promise<boolean> {
  const result = await db.$client.prepare(`
    UPDATE messages
       SET parts = json_insert(parts, '$[#]', json(?))
     WHERE id = ?
       AND conversation_id = ?
       AND role = 'assistant'
       -- Terminal, not successful. A turn that errored or was interrupted is just as finished, and
       -- a result that arrives for one still belongs on it.
       AND status <> 'streaming'
       AND EXISTS (SELECT 1 FROM conversations WHERE id = messages.conversation_id AND user_id = ?)
       AND NOT EXISTS (
         SELECT 1 FROM json_each(parts)
          WHERE json_extract(value, '$.type') = 'tool_result'
            AND json_extract(value, '$.call_id') = ?
       )
  `).bind(JSON.stringify(part), messageId, conversationId, userId, part.call_id).run()
  return result.meta.changes === 1
}

/**
 * Replaces one current head's complete Parts snapshot. Both the old JSON and Conversation head are part
 * of the same SQLite compare-and-swap, so a concurrent answer and a stale send cannot both win.
 */
export async function replaceMessagePartsIfCurrentHead(
  db: DB,
  expected: MessageRow,
  userId: number,
  nextParts: Part[],
): Promise<boolean> {
  const updated = await db.$client.prepare(`
    UPDATE messages
       SET parts = json(?)
     WHERE id = ?
       AND conversation_id = ?
       AND role = 'assistant'
       -- Terminal, not successful. A turn that errored or was interrupted is just as finished, and
       -- a result that arrives for one still belongs on it.
       AND status <> 'streaming'
       AND json(parts) = json(?)
       AND EXISTS (
         SELECT 1 FROM conversations WHERE id = ? AND head_message_id = ? AND user_id = ?
       )
    RETURNING id
  `).bind(
    JSON.stringify(nextParts), expected.id, expected.conversation_id, JSON.stringify(expected.parts),
    expected.conversation_id, expected.id, userId,
  ).first<{ id: number }>()
  return updated?.id === expected.id
}

export async function insertMessage(db: DB, userId: number, row: Omit<MessageRow, 'id'>): Promise<MessageRow> {
  const inserted = await db.$client.prepare(`
    INSERT INTO messages (conversation_id, parent_id, seq, role, parts, provider_id, model_id, usage, status, error, created_at)
    SELECT ?, ?, ?, ?, json(?), ?, ?, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM conversations WHERE id = ? AND user_id = ?)
       AND (? IS NULL OR EXISTS (SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?))
    RETURNING id
  `).bind(row.conversation_id, row.parent_id, row.seq, row.role, JSON.stringify(row.parts), row.provider_id, row.model_id,
    row.usage === null ? null : JSON.stringify(row.usage), row.status, row.error, row.created_at,
    row.conversation_id, userId, row.parent_id, row.parent_id, row.conversation_id).first<{ id: number }>()
  if (!inserted) throw new Error('conversation or parent message not found')
  return (await getMessage(db, inserted.id, userId))!
}

export async function deleteMessage(db: DB, id: number, userId: number): Promise<void> {
  await db.delete(messages).where(and(eq(messages.id, id), ownedMessages(db, userId)))
}

/** Deletes an unannounced shell only while no Conversation head references it. */
export async function deleteMessageIfUnreferenced(db: DB, id: number, userId: number): Promise<boolean> {
  const deleted = await db.$client.prepare(`
    DELETE FROM messages
     WHERE id = ?
       AND EXISTS (SELECT 1 FROM conversations WHERE id = messages.conversation_id AND user_id = ?)
       AND NOT EXISTS (SELECT 1 FROM conversations WHERE head_message_id = ?)
    RETURNING id
  `).bind(id, userId, id).first<{ id: number }>()
  return deleted?.id === id
}

/** Creates the sole assistant continuation for one tool-call parent with an atomic SQLite fence. */
export async function insertAssistantChildIfAbsent(
  db: DB,
  userId: number,
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
         SELECT 1 FROM conversations WHERE id = ? AND head_message_id = ? AND user_id = ?
       )
    RETURNING id
  `).bind(
    row.conversation_id, row.parent_id, row.seq, JSON.stringify(row.parts), row.provider_id, row.model_id,
    row.usage === null ? null : JSON.stringify(row.usage), row.status, row.error, row.created_at, row.parent_id,
    row.conversation_id, row.parent_id, userId,
  ).first<{ id: number }>()
  return inserted ? getMessage(db, inserted.id, userId) : undefined
}

export async function finalizeMessage(
  db: DB,
  id: number,
  userId: number,
  patch: { parts: Part[]; usage: Usage | null; status: PersistedStatus; error: string | null },
): Promise<void> {
  await db.update(messages).set(patch).where(and(eq(messages.id, id), ownedMessages(db, userId)))
}

/**
 * The model the conversation last generated with. `edit` carries no model of its own, and
 * `conversations.provider_id` is now the user's explicit override rather than a sticky record of the
 * last generation, so the answer has to come from the messages themselves.
 */
export async function lastGenerationModel(db: DB, conversationId: number, userId: number): Promise<{ provider_id: number; model_id: string } | undefined> {
  const [row] = await db.select({ provider_id: messages.provider_id, model_id: messages.model_id })
    .from(messages)
    .where(and(eq(messages.conversation_id, conversationId), ownedMessages(db, userId), isNotNull(messages.provider_id), isNotNull(messages.model_id)))
    .orderBy(desc(messages.seq))
    .limit(1)
  if (!row || row.provider_id === null || row.model_id === null) return undefined
  return { provider_id: row.provider_id, model_id: row.model_id }
}

export async function maxSeq(db: DB, conversationId: number, userId: number): Promise<number> {
  const [row] = await db.select({ max: sql<number>`coalesce(max(${messages.seq}), 0)` }).from(messages).where(and(eq(messages.conversation_id, conversationId), ownedMessages(db, userId)))
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

export async function getProvider(db: DB, id: number, userId: number): Promise<ProviderRow | undefined> {
  return db.query.providers.findFirst({ where: and(eq(providers.id, id), eq(providers.user_id, userId)) })
}

export async function getModel(db: DB, providerId: number, modelId: string, userId: number): Promise<ModelRow | undefined> {
  return db.query.models.findFirst({ where: and(eq(models.provider_id, providerId), eq(models.model_id, modelId),
    inArray(models.provider_id, db.select({ id: providers.id }).from(providers).where(eq(providers.user_id, userId)))) })
}

export async function getProviderInterface(db: DB, id: number, userId: number): Promise<ProviderInterfaceRow | undefined> {
  return db.query.providerInterfaces.findFirst({ where: and(eq(providerInterfaces.id, id),
    inArray(providerInterfaces.provider_id, db.select({ id: providers.id }).from(providers).where(eq(providers.user_id, userId)))) })
}

export async function getAttachment(db: DB, id: number, userId: number): Promise<AttachmentRow | undefined> {
  return db.query.attachments.findFirst({ where: and(eq(attachments.id, id), eq(attachments.user_id, userId)) })
}

export type ProviderFileScope = Pick<ScopedFilesClient, 'family' | 'baseURL' | 'credentialVersion'> & { providerId: number }

/** Match the Files endpoint and credentials, retaining expired references for remote cleanup. */
export async function findReusableProviderFile(db: DB, scope: ProviderFileScope, attachmentId: number, now: number, userId: number): Promise<AttachmentProviderFileRow | undefined> {
  const baseURL = normalizeFilesBaseURL(scope.baseURL, scope.family)
  const where = and(
    eq(attachmentProviderFiles.attachment_id, attachmentId),
    eq(attachmentProviderFiles.provider_id, scope.providerId),
    eq(attachmentProviderFiles.credential_version, scope.credentialVersion),
    eq(attachmentProviderFiles.file_family, scope.family),
    gt(attachmentProviderFiles.expires_at, now),
    inArray(attachmentProviderFiles.provider_id, db.select({ id: providers.id }).from(providers).where(eq(providers.user_id, userId))),
    inArray(attachmentProviderFiles.attachment_id, db.select({ id: attachments.id }).from(attachments).where(eq(attachments.user_id, userId))),
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
        await db.update(attachmentProviderFiles).set({ base_url: normalized }).where(and(eq(attachmentProviderFiles.id, row.id), where))
      }
      return { ...row, base_url: normalized }
    }
    cursor = rows.at(-1)!
  }
}

/** Append each upload so older remote references remain available for cleanup. */
export async function insertProviderFile(db: DB, row: typeof attachmentProviderFiles.$inferInsert, userId: number): Promise<void> {
  const [attachment, provider] = await Promise.all([getAttachment(db, row.attachment_id, userId), getProvider(db, row.provider_id, userId)])
  if (!attachment || !provider) throw new Error('attachment or provider not found')
  await db.insert(attachmentProviderFiles).values({ ...row, base_url: normalizeFilesBaseURL(row.base_url, row.file_family) })
}
