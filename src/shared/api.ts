import { z } from 'zod'
import { ModelMetadataOverrideSchema } from './model-metadata'
import { InterfaceProtocolSchema, ModelCapabilitiesSchema, ModelPricingSchema, ProtocolSchema, SessionParamsSchema } from './models'

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

/** One interface submitted as part of an atomic provider write. It never carries a credential. */
const ProviderInterfaceInputBaseSchema = {
  id: z.number().int().optional(),
  base_url: z.string().url(),
}

export const ProviderInterfaceInputSchema = z.discriminatedUnion('protocol', [
  z.strictObject({ ...ProviderInterfaceInputBaseSchema, protocol: z.literal('responses'), native_files: z.boolean().optional() }),
  z.strictObject({ ...ProviderInterfaceInputBaseSchema, protocol: z.literal('chat-completions'), native_files: z.boolean().optional() }),
  z.strictObject({ ...ProviderInterfaceInputBaseSchema, protocol: z.literal('anthropic'), native_files: z.boolean().optional() }),
  z.strictObject({ ...ProviderInterfaceInputBaseSchema, protocol: z.literal('vertex-compatible'), native_files: z.literal(false).optional() }),
])
export type ProviderInterfaceInput = z.infer<typeof ProviderInterfaceInputSchema>

export const ModelsDevProviderAssociationInputSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('endpoint') }),
  z.strictObject({ source: z.literal('manual'), provider_id: z.string().min(1) }),
])
export type ModelsDevProviderAssociationInput = z.infer<typeof ModelsDevProviderAssociationInputSchema>

/** New atomic provider input, introduced alongside the legacy ProviderInput during the staged cutover. */
export const ProviderWriteInputSchema = z.strictObject({
  name: z.string().min(1).max(100),
  /** Plaintext key on input only; the API encrypts it before persistence. */
  api_key: z.string().optional(),
  enabled: z.boolean().optional(),
  interfaces: z.array(ProviderInterfaceInputSchema).min(1),
  default_protocol: InterfaceProtocolSchema,
  models_dev_provider: ModelsDevProviderAssociationInputSchema.optional(),
}).superRefine((value, context) => {
  const protocols = value.interfaces.map(entry => entry.protocol)
  if (new Set(protocols).size !== protocols.length) {
    context.addIssue({ code: 'custom', message: 'Provider interface protocols must be unique', path: ['interfaces'] })
  }
  if (!protocols.includes(value.default_protocol)) {
    context.addIssue({ code: 'custom', message: 'Default protocol must be included in interfaces', path: ['default_protocol'] })
  }
})
export type ProviderWriteInput = z.infer<typeof ProviderWriteInputSchema>

/** New model input retaining only user intent; catalog metadata never creates model membership. */
export const ModelWriteInputSchema = z.strictObject({
  model_id: z.string().min(1),
  interface_id: z.number().int().nullable().optional(),
  metadata_override: ModelMetadataOverrideSchema.optional(),
  enabled: z.boolean().optional(),
  sort: z.number().int().optional(),
})
export type ModelWriteInput = z.infer<typeof ModelWriteInputSchema>

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
