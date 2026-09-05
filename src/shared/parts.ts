import { z } from 'zod'

export const ProviderOptionsSchema = z.record(z.string(), z.record(z.string(), z.unknown()))
export type ProviderOptions = z.infer<typeof ProviderOptionsSchema>

export const TextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  providerOptions: ProviderOptionsSchema.optional(),
})
export const ImagePartSchema = z.object({ type: z.literal('image'), attachment_id: z.number().int() })
export const ReasoningPartSchema = z.object({
  type: z.literal('reasoning'),
  text: z.string(),
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
