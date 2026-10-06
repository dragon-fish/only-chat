import type { Hub } from '@/server/plugins/hub'
import { CONTEXT_COMPACTION_PLUGIN_ID, CompactionCommandSchema, type CompactionEvent } from '../shared'

/**
 * `/compress` (spec §3.7): a compaction under the current head that nothing continues. The hub is the
 * person's own, and `requestCheckpoint` reads the conversation under their id, so another account's
 * conversation reads as not found. The answer goes back with the request's id.
 */
export async function handleCompactionCommand(hub: Hub, payload: unknown): Promise<void> {
  const command = CompactionCommandSchema.parse(payload)
  const outcome = await hub.compaction.requestCheckpoint({ conversationId: command.conversationId, focus: command.focus ?? null })
  const event: CompactionEvent = outcome.ok
    ? { type: 'compress.result', requestId: command.requestId, ok: true }
    : { type: 'compress.result', requestId: command.requestId, ok: false, error: outcome.error }
  await hub.broadcastPlugin(CONTEXT_COMPACTION_PLUGIN_ID, event)
}
