import { z } from 'zod'

export { CONTEXT_COMPACTION_PLUGIN_ID } from '@/shared/plugins'

/** The user's switch: whether compaction happens on its own, or only through `/compress`. */
export const CONTEXT_COMPACTION_CONFIG_SCHEMA = z.object({
  auto: z.boolean().default(true),
})
export type ContextCompactionConfig = z.infer<typeof CONTEXT_COMPACTION_CONFIG_SCHEMA>

/** What the plugin keeps in a checkpoint's `data`. The core never reads it. */
export interface CompactionData {
  trigger: 'auto' | 'manual' | 'overflow'
  summary: string
  files: { read: string[], modified: string[] }
  focus: string | null
  /** Estimated size of what the checkpoint replaced, in tokens. */
  tokensBefore: number
  /** `cached`: the conversation's own model on its cached prefix; `flattened`: the compaction fallback model. */
  mode: 'cached' | 'flattened'
}

/** Client → server, over `plugin.command`. */
export const CompactionCommandSchema = z.object({
  type: z.literal('compress'),
  requestId: z.string().min(1).max(64),
  conversationId: z.number().int().positive(),
  focus: z.string().max(2000).nullable().optional(),
})
export type CompactionCommand = z.infer<typeof CompactionCommandSchema>

/** Server → client, over `plugin.event`. Events are not buffered: a reconnect reads `compacting` from the snapshot. */
export type CompactionEvent =
  /** The answer to one `/compress`, matched by `requestId`. */
  | { type: 'compress.result', requestId: string, ok: true }
  | { type: 'compress.result', requestId: string, ok: false, error: string }
  /** Automatic compaction failed, or compacting did not bring the context under the trigger line. */
  | { type: 'notice', conversationId: number, kind: 'failed' | 'ineffective', message: string }
