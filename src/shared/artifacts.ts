import { z } from 'zod'

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
