import { z } from 'zod'
import { ModelCapabilitiesSchema, ModelPricingSchema, ProtocolSchema, SessionParamsSchema } from './models'

export interface ModelRef {
  provider_id: number
  model_id: string
}

/** Only `name` is required; prompt, model and params may all be absent or explicitly cleared. */
export const ProjectInputSchema = z.object({
  name: z.string().min(1).max(200),
  system_prompt: z.string().nullable().optional(),
  provider_id: z.number().int().nullable().optional(),
  model_id: z.string().nullable().optional(),
  params: SessionParamsSchema.nullable().optional(),
})
export type ProjectInput = z.infer<typeof ProjectInputSchema>

export const ProviderInputSchema = z.object({
  name: z.string().min(1).max(100),
  protocol: ProtocolSchema,
  base_url: z.string().url(),
  /** Plaintext key on input only; stored encrypted. Omit to keep the existing key. */
  api_key: z.string().optional(),
  extra: z.record(z.string(), z.unknown()).nullable().optional(),
  enabled: z.boolean().optional(),
  /** Supports the provider's native Files API with upload-time expiry. Custom providers default false. */
  native_files: z.boolean().optional(),
})
export type ProviderInput = z.infer<typeof ProviderInputSchema>

export const ModelInputSchema = z.object({
  model_id: z.string().min(1),
  display_name: z.string().min(1).optional(),
  capabilities: ModelCapabilitiesSchema.optional(),
  pricing: ModelPricingSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  sort: z.number().int().optional(),
})
export type ModelInput = z.infer<typeof ModelInputSchema>

export const AttachmentCheckRequestSchema = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) })
export type AttachmentCheckRequest = z.infer<typeof AttachmentCheckRequestSchema>
export interface AttachmentCheckResponse {
  exists: boolean
  attachment_id?: number
}
export interface AttachmentUploadResponse {
  attachment_id: number
}
export interface FetchModelsResponse {
  imported: number
  models: string[]
}
