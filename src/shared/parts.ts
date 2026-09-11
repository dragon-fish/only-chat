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
  providerOptions: ProviderOptionsSchema.optional(),
})

export const PartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ImagePartSchema,
  ReasoningPartSchema,
  ToolCallPartSchema,
  ToolResultPartSchema,
])
export const PartsSchema = z.array(PartSchema)

export type TextPart = z.infer<typeof TextPartSchema>
export type ImagePart = z.infer<typeof ImagePartSchema>
export type ReasoningPart = z.infer<typeof ReasoningPartSchema>
export type ToolCallPart = z.infer<typeof ToolCallPartSchema>
export type ToolResultPart = z.infer<typeof ToolResultPartSchema>
export type Part = z.infer<typeof PartSchema>
