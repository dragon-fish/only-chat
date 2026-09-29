import { z } from 'zod'
import { ModelRefSchema } from './model-ref'

/** Keys the Images request always sets itself; an extra entry may not replace them. */
export const IMAGE_EXTRA_RESERVED_KEYS: readonly string[] = ['model', 'prompt', 'n', 'image']

/**
 * Provider-specific request body fields, like the OpenAI SDK's `extra_body` (Seedream's
 * `watermark: false`, for one). Merged last into the Images request, so an entry here overrides a
 * standard option of the same name — `size: '2K'` is a legitimate Seedream value `size` cannot express.
 */
export const ImageExtraBodySchema = z.record(z.string().trim().min(1).max(64), z.json())
  .refine(value => Object.keys(value).length <= 32, 'At most 32 extra body entries')
  .refine(value => Object.keys(value).every(key => !IMAGE_EXTRA_RESERVED_KEYS.includes(key)), `Extra body cannot set ${IMAGE_EXTRA_RESERVED_KEYS.join(', ')}`)
export type ImageExtraBody = z.infer<typeof ImageExtraBodySchema>

export const ImageGenerationParamsSchema = z.strictObject({
  count: z.number().int().min(1).max(10).default(1),
  size: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }).nullable().default(null),
  quality: z.string().trim().min(1).max(50).optional(),
  background: z.enum(['transparent', 'opaque']).optional(),
  output_format: z.enum(['png', 'webp', 'jpeg']).optional(),
  /** This run's own entries only; the model's defaults are merged underneath when the run executes. */
  extra: ImageExtraBodySchema.optional(),
})
export type ImageGenerationParams = z.infer<typeof ImageGenerationParamsSchema>

export const ArtifactRunStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled'])
export type ArtifactRunStatus = z.infer<typeof ArtifactRunStatusSchema>

export interface ArtifactUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  generated_images?: number
}

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

export interface ArtifactRunDto {
  id: number
  user_id: number
  client_request_id: string
  kind: 'image_generation'
  source: 'studio' | 'tool' | 'provider_tool' | 'chat_output'
  operation: 'generate' | 'edit'
  status: ArtifactRunStatus
  conversation_id: number | null
  message_id: number | null
  provider_name: string
  provider_id: number | null
  interface_protocol: string
  model_id: string
  model_name: string
  prompt: string
  params: ImageGenerationParams
  error: string | null
  usage: ArtifactUsage | null
  created_at: number
  started_at: number | null
  completed_at: number | null
  reference_attachment_ids?: number[]
}

export interface ArtifactDto {
  id: number
  user_id: number
  run_id: number
  kind: 'image'
  attachment_id: number
  output_index: number
  width: number | null
  height: number | null
  mime: string
  created_at: number
  deleted_at: number | null
  prompt: string
  params: ImageGenerationParams
  source: ArtifactRunDto['source']
  operation: ArtifactRunDto['operation']
  status: ArtifactRunStatus
  provider_name: string
  provider_id: number | null
  interface_protocol: string
  model_id: string
  model_name: string
  conversation_id: number | null
  message_id: number | null
}

export interface ArtifactPage { artifacts: ArtifactDto[]; next_cursor: string | null }

/** The artifact run behind an `image_run:<id>` task id. */
export function runIdOf(taskId: string): number | null {
  const match = /^image_run:(\d+)$/.exec(taskId)
  return match ? Number(match[1]) : null
}
