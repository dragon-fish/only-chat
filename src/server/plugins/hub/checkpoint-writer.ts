import { and, eq, inArray } from 'drizzle-orm'
import { attachments } from '../../db/schema'
import type { Message, Usage } from '@/shared/models'
import { CheckpointPartSchema, type CheckpointPart } from '@/shared/parts'
import { pluginManifests } from '@/shared/plugin-manifests'
import { visibleAttachments } from '@/plugins/file-reader/server/visible'
import { getConversation, getMessage, listMessages, maxSeq, toMessage } from './conversations'
import { projectContext, type ContextProjection } from './checkpoint'
import { awaitsHuman } from './tasks'
import { pathToRoot } from './tree'
import type { Hub } from './index'

/** One plugin's contribution to a checkpoint's content, collected by `checkpoint/compose`. */
export interface CheckpointBlock {
  pluginId: string
  text: string
}

/**
 * Handed to `checkpoint/compose` before a checkpoint is written (spec §1.5). Collect-only: a listener
 * appends to `blocks` and does nothing else — the checkpoint may still fail, and then nothing it did
 * may have happened.
 */
export interface CheckpointComposePayload {
  userId: number
  conversationId: number
  projectId: number | null
  /** The tools of the turn being compacted, requirements included. */
  toolIds: readonly string[]
  /** The whole structural path the checkpoint will follow. */
  path: readonly Message[]
  projection: ContextProjection
  blocks: CheckpointBlock[]
}

/** Handed to `checkpoint/committed` once the checkpoint is written; never for one that was not. */
export interface CheckpointCommittedPayload {
  userId: number
  conversationId: number
  part: CheckpointPart
  /** The checkpoint message as stored, now the conversation's head. */
  message: Message
}

export interface CheckpointCommit {
  conversationId: number
  /** The head the checkpoint is written under. If the head has moved since, nothing is written. */
  expectedHead: number
  part: CheckpointPart
  /** What producing the checkpoint cost. */
  usage: Usage | null
}

/** Below D1's 100 bound parameters, with room for the user id. */
const ID_BATCH = 90

/**
 * Blocks in plugin manifest order, each plugin's in the order it added them — listeners run in
 * parallel, so arrival order is no order — and the plugins that contributed, once each, in that order.
 */
export function orderCheckpointBlocks(blocks: readonly CheckpointBlock[]): { blocks: CheckpointBlock[], contributors: string[] } {
  const rank = new Map(pluginManifests.map((manifest, index) => [manifest.id, index]))
  const ordered = blocks
    .map((block, index) => ({ block, index }))
    .sort((a, b) => (rank.get(a.block.pluginId) ?? Infinity) - (rank.get(b.block.pluginId) ?? Infinity) || a.index - b.index)
    .map(({ block }) => block)
  return { blocks: ordered, contributors: [...new Set(ordered.map(block => block.pluginId))] }
}

/**
 * The core's half of compaction (spec §1.4, §1.5): collecting what plugins add to a checkpoint, and
 * writing one. What a checkpoint says, and when one is due, is a plugin's business, not this one's.
 */
export class Checkpoints {
  constructor(private readonly hub: Hub) {}

  /** Emits `checkpoint/compose` and returns its blocks in manifest order, with their contributors. */
  async compose(input: { conversationId: number, projectId: number | null, toolIds: readonly string[], path: readonly Message[] }) {
    const payload: CheckpointComposePayload = {
      userId: this.hub.userId, ...input, projection: projectContext(input.path), blocks: [],
    }
    await this.hub.app.parallel('checkpoint/compose', payload)
    return orderCheckpointBlocks(payload.blocks)
  }

  /**
   * Writes `part` as an assistant message under `expectedHead` and moves the head onto it, in one D1
   * batch that compares and swaps the head: if anything moved it meanwhile, nothing is written and
   * this returns null. Throws for a checkpoint that may not be written at all.
   */
  async commit(input: CheckpointCommit): Promise<Message | null> {
    const { hub } = this
    const { conversationId, expectedHead, usage } = input
    const part = CheckpointPartSchema.parse(input.part)
    const conversation = await getConversation(hub.db, conversationId, hub.userId)
    if (!conversation) throw new Error('conversation not found')
    if (conversation.head_message_id !== expectedHead) return null
    if (hub.inflight().some(job => job.message.id === expectedHead)) throw new Error('cannot checkpoint a message still being written')

    const byId = new Map((await listMessages(hub.db, conversationId, hub.userId)).map(row => [row.id, toMessage(row)]))
    const path = pathToRoot(byId, expectedHead)
    // A question to the person keeps the floor: compacting over it would bury the call it waits on.
    if (awaitsHuman(path.at(-1), name => hub.app.tools.human(name) !== undefined)) {
      throw new Error('tool calls are waiting for an answer')
    }
    await this.assertAttachments(part.attachments, path)

    const seq = await hub.seq.allocate(conversationId, () => maxSeq(hub.db, conversationId, hub.userId))
    const now = Date.now()
    const client = hub.db.$client
    // Both statements carry the same head condition and run in one transaction, so either the
    // message exists and is the head, or neither happened. The head is found by (conversation, seq),
    // which is unique, rather than `last_insert_rowid()`, which survives from earlier statements.
    const [inserted, moved] = await client.batch<{ id: number }>([
      client.prepare(`
        INSERT INTO messages (conversation_id, parent_id, seq, role, parts, provider_id, model_id, usage, status, error, notes, created_at)
        SELECT ?, ?, ?, 'assistant', json(?), NULL, NULL, ?, 'done', NULL, NULL, ?
         WHERE EXISTS (SELECT 1 FROM conversations WHERE id = ? AND user_id = ? AND head_message_id = ?)
        RETURNING id
      `).bind(conversationId, expectedHead, seq, JSON.stringify([part]), usage === null ? null : JSON.stringify(usage), now,
        conversationId, hub.userId, expectedHead),
      client.prepare(`
        UPDATE conversations
           SET head_message_id = (SELECT id FROM messages WHERE conversation_id = ? AND seq = ? AND parent_id = ?), updated_at = ?
         WHERE id = ? AND user_id = ? AND head_message_id = ?
           AND EXISTS (SELECT 1 FROM messages WHERE conversation_id = ? AND seq = ? AND parent_id = ?)
        RETURNING id
      `).bind(conversationId, seq, expectedHead, now, conversationId, hub.userId, expectedHead, conversationId, seq, expectedHead),
    ])
    const id = inserted?.results[0]?.id
    if (id === undefined || moved?.results[0]?.id !== conversationId) return null

    const row = await getMessage(hub.db, id, hub.userId)
    const updated = await getConversation(hub.db, conversationId, hub.userId)
    if (!row || !updated) throw new Error('checkpoint disappeared after it was written')
    const message = toMessage(row)
    await hub.broadcast({ type: 'message.created', message })
    await hub.broadcast({ type: 'head.changed', conversation_id: conversationId, message_id: message.id })
    await hub.emitConversationUpdated(updated)
    // Written either way; a plugin failing to record its own state cannot take the checkpoint back.
    const committed: CheckpointCommittedPayload = { userId: hub.userId, conversationId, part, message }
    await hub.app.parallel('checkpoint/committed', committed)
      .catch(error => console.error('checkpoint/committed listener failed', error))
    return message
  }

  /** Every attachment is this user's and was shown on the structural path the checkpoint follows. */
  private async assertAttachments(ids: readonly number[], path: readonly Message[]): Promise<void> {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return
    const shown = visibleAttachments(path)
    const owned = new Set<number>()
    for (let start = 0; start < unique.length; start += ID_BATCH) {
      const rows = await this.hub.db.select({ id: attachments.id }).from(attachments)
        .where(and(eq(attachments.user_id, this.hub.userId), inArray(attachments.id, unique.slice(start, start + ID_BATCH))))
      for (const row of rows) owned.add(row.id)
    }
    for (const id of unique) {
      // Another account's attachment reads as missing, never as "not yours".
      if (!owned.has(id) || !shown.has(id)) throw new Error(`attachment ${id} not found`)
    }
  }
}
