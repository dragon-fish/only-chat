import { z } from 'zod'

export const ProviderOptionsSchema = z.record(z.string(), z.record(z.string(), z.unknown()))
export type ProviderOptions = z.infer<typeof ProviderOptionsSchema>

export const TextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  providerOptions: ProviderOptionsSchema.optional(),
})
export const ImagePartSchema = z.object({
  type: z.literal('image'),
  attachment_id: z.number().int(),
  artifact_id: z.number().int().optional(),
})
export const ReasoningPartSchema = z.object({
  type: z.literal('reasoning'),
  text: z.string(),
  /**
   * Wall-clock milliseconds the model spent on this block, stamped server-side when it closes.
   * Measured here rather than in the browser so it survives a reload — a duration the reader can
   * only see while the tab that produced it stays open is not worth showing. Optional: parts
   * persisted before this existed have none, and a block that never closed has none either.
   */
  duration_ms: z.number().int().nonnegative().optional(),
  providerOptions: ProviderOptionsSchema.optional(),
})
export const ToolCallPartSchema = z.object({
  type: z.literal('tool_call'),
  id: z.string(),
  name: z.string(),
  args: z.unknown(),
  providerOptions: ProviderOptionsSchema.optional(),
})
export const ToolResultPartSchema = z.object({
  type: z.literal('tool_result'),
  call_id: z.string(),
  name: z.string(),
  content: z.unknown(),
  /**
   * Images the tool showed the model. They reach it as a user message right after the tool results,
   * not inside them: a tool result can only carry base-64, resent on every later turn, and one
   * protocol cannot carry it at all.
   */
  attachments: z.array(z.number().int()).optional(),
  providerOptions: ProviderOptionsSchema.optional(),
})

/**
 * A background task's outcome, delivered to the model inside a user message. User role because a
 * mid-conversation `developer`/`system` message is not accepted by every protocol.
 */
export const TaskNotificationPartSchema = z.object({
  type: z.literal('task_notification'),
  task_id: z.string().min(1).max(200),
  plugin_id: z.string().min(1),
  tool_call_id: z.string().min(1),
  status: z.enum(['completed', 'failed', 'cancelled']),
  text: z.string().max(20_000),
})

export const PartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ImagePartSchema,
  ReasoningPartSchema,
  ToolCallPartSchema,
  ToolResultPartSchema,
  TaskNotificationPartSchema,
])
export const PartsSchema = z.array(PartSchema)

export type TextPart = z.infer<typeof TextPartSchema>
export type ImagePart = z.infer<typeof ImagePartSchema>
export type ReasoningPart = z.infer<typeof ReasoningPartSchema>
export type ToolCallPart = z.infer<typeof ToolCallPartSchema>
export type ToolResultPart = z.infer<typeof ToolResultPartSchema>
export type TaskNotificationPart = z.infer<typeof TaskNotificationPartSchema>
export type Part = z.infer<typeof PartSchema>

/**
 * The key under which a tool's output hands over attachment ids for the model to see. Reserved:
 * `toolResultPart` lifts it onto the part, so it never persists inside `content`.
 */
export const TOOL_ATTACHMENTS_KEY = '__attachments'

export function toolResultPart(callId: string, name: string, output: unknown): ToolResultPart {
  if (output === null || typeof output !== 'object' || Array.isArray(output) || !(TOOL_ATTACHMENTS_KEY in output)) {
    return { type: 'tool_result', call_id: callId, name, content: output }
  }
  const { [TOOL_ATTACHMENTS_KEY]: ids, ...content } = output as Record<string, unknown>
  const attachments = Array.isArray(ids) ? ids.filter((id): id is number => Number.isSafeInteger(id)) : []
  return { type: 'tool_result', call_id: callId, name, content, ...(attachments.length ? { attachments } : {}) }
}

/**
 * What the model reads of a tool output that handed over attachments: everything but the reserved
 * key. A tool doing so must pass this through `toModelOutput`, because the SDK builds its own
 * in-turn messages from the raw output, and the rebuilt history — from the stored part — has no key.
 */
export function stripToolAttachments(output: unknown): unknown {
  return toolResultPart('', '', output).content
}

/** A user message made only of notifications was written by the server, not the person. */
export function isNotificationOnly(parts: readonly Part[]): boolean {
  return parts.length > 0 && parts.every(part => part.type === 'task_notification')
}
