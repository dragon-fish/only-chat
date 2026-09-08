import { z } from 'zod'
import { ModelMetadataOverrideSchema } from './model-metadata'
import { InterfaceProtocolSchema, ProviderWithInterfacesSchema, SessionParamsSchema } from './models'

export const CodexOAuthStartResponseSchema = z.strictObject({
  flow_id: z.string().uuid(),
  verification_url: z.string().url(),
  user_code: z.string().min(1),
  expires_at: z.number().int(),
  poll_interval_ms: z.number().int().positive(),
})
export type CodexOAuthStartResponse = z.infer<typeof CodexOAuthStartResponseSchema>

export const CodexOAuthPollResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('pending'), next_poll_at: z.number().int() }),
  z.strictObject({ status: z.literal('complete'), provider: ProviderWithInterfacesSchema, model_sync_warning: z.string().optional() }),
  z.strictObject({ status: z.literal('failed'), error: z.string() }),
])
export type CodexOAuthPollResponse = z.infer<typeof CodexOAuthPollResponseSchema>

export interface ModelRef {
  provider_id: number
  model_id: string
}

/** Only `name` is required; prompt, model and params may all be absent or explicitly cleared. */
export const ProjectInputSchema = z.object({
  name: z.string().min(1).max(200),
  icon_attachment_id: z.number().int().nullable().optional(),
  system_prompt: z.string().nullable().optional(),
  provider_id: z.number().int().nullable().optional(),
  model_id: z.string().nullable().optional(),
  params: SessionParamsSchema.nullable().optional(),
})
export type ProjectInput = z.infer<typeof ProjectInputSchema>

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

/** Atomic provider input shares one credential across all configured interfaces. */
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

export const CodexProviderUpdateSchema = z.strictObject({
  name: z.string().min(1).max(100),
  enabled: z.boolean().optional(),
})
export type CodexProviderUpdate = z.infer<typeof CodexProviderUpdateSchema>

/** Model input retains only user intent; catalog metadata never creates model membership. */
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
  removed: number
  unavailable: number
  models: string[]
}

export const BulkModelStateInputSchema = z.strictObject({
  enabled: z.boolean(),
  lab_id: z.string().min(1).nullable().optional(),
})
export type BulkModelStateInput = z.infer<typeof BulkModelStateInputSchema>
export interface BulkModelStateResponse { updated: number; deleted: number }

export interface CatalogProviderSummary { id: string; name: string; api?: string; npm?: string; doc?: string }
export interface CatalogStatus { version: string | null; previousVersion: string | null; lastSuccessAt: number | null; lastError: string | null }
export interface CatalogRefreshStartResponse { instanceId: string }
export type CatalogRefreshJobState = 'queued' | 'running' | 'paused' | 'errored' | 'terminated' | 'complete' | 'waiting' | 'waitingForPause' | 'unknown'
export interface CatalogRefreshJobStatus { status: CatalogRefreshJobState; error?: string }
