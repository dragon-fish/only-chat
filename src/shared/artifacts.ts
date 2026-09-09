import { z } from 'zod'
import { ModelRefSchema } from './model-ref'

export const ImageGenerationParamsSchema = z.strictObject({
  count: z.number().int().min(1).max(10).default(1),
  size: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }).nullable().default(null),
  quality: z.string().trim().min(1).max(50).optional(),
  background: z.enum(['transparent', 'opaque']).optional(),
  output_format: z.enum(['png', 'webp', 'jpeg']).optional(),
})
export type ImageGenerationParams = z.infer<typeof ImageGenerationParamsSchema>

export const ArtifactRunStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled'])
export type ArtifactRunStatus = z.infer<typeof ArtifactRunStatusSchema>

export const CreateImageRunInputSchema = z.strictObject({
  client_request_id: z.string().uuid(),
  conversation_id: z.number().int().positive().optional(),
  model: ModelRefSchema,
  prompt: z.string().min(1).max(32_000).refine(value => value.trim().length > 0, 'prompt must not be blank'),
  reference_attachment_ids: z.array(z.number().int().positive()).max(10).default([]),
  params: ImageGenerationParamsSchema,
})
export type CreateImageRunInput = z.infer<typeof CreateImageRunInputSchema>

export interface CreateImageRunResponse {
  run_id: number
  conversation_id: number
  message_id: number
}
