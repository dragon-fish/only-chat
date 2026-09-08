import { z } from 'zod'
import { CatalogMatchesSchema, ModelMetadataSchema, ModelMetadataOverrideSchema } from './model-metadata'
import { PartsSchema } from './parts'

/** Supported provider interfaces. */
export const InterfaceProtocolSchema = z.enum(['responses', 'chat-completions', 'anthropic', 'vertex-compatible'])
export type InterfaceProtocol = z.infer<typeof InterfaceProtocolSchema>

/** undefined = provider did not report; 0 = reported zero. Never collapse the two. */
export const UsageSchema = z.object({
  prompt: z.number().optional(),
  completion: z.number().optional(),
  cached: z.number().optional(),
  reasoning: z.number().optional(),
  time_to_first_token_ms: z.number().nonnegative().optional(),
  generation_duration_ms: z.number().nonnegative().optional(),
  total_duration_ms: z.number().nonnegative().optional(),
})
export type Usage = z.infer<typeof UsageSchema>

export const MessageStatusSchema = z.enum(['streaming', 'done', 'error', 'aborted'])
export type MessageStatus = z.infer<typeof MessageStatusSchema>
export const PersistedStatusSchema = z.enum(['done', 'error', 'aborted'])
export type PersistedStatus = z.infer<typeof PersistedStatusSchema>

/** Reasoning effort levels across all protocols; not every model or protocol accepts every level. */
export const ReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>

export const SessionParamsSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  /** Missing = inherit. Independent from `reasoning_effort`. */
  reasoning_enabled: z.boolean().optional(),
  /** Missing = inherit; `null` = explicit Auto (reasoning on, no effort sent); string = explicit effort. */
  reasoning_effort: ReasoningEffortSchema.nullable().optional(),
})
export type SessionParams = z.infer<typeof SessionParamsSchema>

export const UserSettingsSchema = z.object({
  plugins: z.record(z.string(), z.boolean()).default({}),
})
export type UserSettings = z.infer<typeof UserSettingsSchema>

export const UserSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  settings: UserSettingsSchema,
  created_at: z.number(),
})
export type User = z.infer<typeof UserSchema>

export const SessionSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  project_id: z.number().int().nullable(),
  title: z.string(),
  head_message_id: z.number().int().nullable(),
  provider_id: z.number().int().nullable(),
  model_id: z.string().nullable(),
  system_prompt: z.string().nullable(),
  params: SessionParamsSchema.nullable(),
  /** Stable selected tool IDs, captured when the Session is first created. */
  tools: z.array(z.string()),
  created_at: z.number(),
  updated_at: z.number(),
  archived_at: z.number().nullable(),
})
export type Session = z.infer<typeof SessionSchema>

/** Only `name` is required; prompt, model and params may all be absent. */
export const ProjectSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  name: z.string(),
  icon_attachment_id: z.number().int().nullable(),
  system_prompt: z.string().nullable(),
  provider_id: z.number().int().nullable(),
  model_id: z.string().nullable(),
  params: SessionParamsSchema.nullable(),
  created_at: z.number(),
  updated_at: z.number(),
})
export type Project = z.infer<typeof ProjectSchema>

export const MessageSchema = z.object({
  id: z.number().int(),
  session_id: z.number().int(),
  parent_id: z.number().int().nullable(),
  seq: z.number().int(),
  role: z.enum(['user', 'assistant']),
  parts: PartsSchema,
  provider_id: z.number().int().nullable(),
  model_id: z.string().nullable(),
  usage: UsageSchema.nullable(),
  status: MessageStatusSchema,
  error: z.string().nullable(),
  created_at: z.number(),
})
export type Message = z.infer<typeof MessageSchema>

/** Provider interface DTO. Credentials remain solely on the server-side provider record. */
const ProviderInterfaceBaseSchema = {
  id: z.number().int(),
  provider_id: z.number().int(),
  base_url: z.string().url(),
  created_at: z.number().int(),
}

export const ProviderInterfaceSchema = z.discriminatedUnion('protocol', [
  z.strictObject({ ...ProviderInterfaceBaseSchema, protocol: z.literal('responses'), native_files: z.boolean() }),
  z.strictObject({ ...ProviderInterfaceBaseSchema, protocol: z.literal('chat-completions'), native_files: z.boolean() }),
  z.strictObject({ ...ProviderInterfaceBaseSchema, protocol: z.literal('anthropic'), native_files: z.boolean() }),
  z.strictObject({ ...ProviderInterfaceBaseSchema, protocol: z.literal('vertex-compatible'), native_files: z.literal(false) }),
])
export type ProviderInterface = z.infer<typeof ProviderInterfaceSchema>

/** Wire DTO: credentials never leave the server; has_key only reports their presence. */
export const ProviderWithInterfacesSchema = z.strictObject({
  id: z.number().int(),
  user_id: z.number().int(),
  name: z.string(),
  has_key: z.boolean(),
  enabled: z.boolean(),
  models_dev_provider_id: z.string().nullable(),
  models_dev_provider_source: z.enum(['manual', 'endpoint']).nullable(),
  default_interface_id: z.number().int().nullable(),
  credential_version: z.number().int(),
  interfaces: z.array(ProviderInterfaceSchema),
  created_at: z.number().int(),
})
export type ProviderWithInterfaces = z.infer<typeof ProviderWithInterfacesSchema>

/** Model wire DTO with effective metadata and the separate user override layer. */
export const ModelWithMetadataSchema = z.strictObject({
  id: z.number().int(),
  provider_id: z.number().int(),
  model_id: z.string(),
  interface_id: z.number().int().nullable(),
  metadata: ModelMetadataSchema,
  metadata_override: ModelMetadataOverrideSchema,
  catalog_matches: CatalogMatchesSchema,
  lab_id: z.string().nullable(),
  enabled: z.boolean(),
  manual_pinned: z.boolean(),
  upstream_available: z.boolean().nullable(),
  sort: z.number().int(),
})
export type ModelWithMetadata = z.infer<typeof ModelWithMetadataSchema>

/** Filters map directly to indexed model columns; cursor values remain opaque to callers. */
export const ModelQuerySchema = z.strictObject({
  provider_id: z.number().int().optional(),
  enabled: z.boolean().optional(),
  interface_id: z.number().int().optional(),
  lab_id: z.string().min(1).optional(),
  vision: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  tools: z.boolean().optional(),
  image_output: z.boolean().optional(),
  min_context: z.number().int().nonnegative().optional(),
  search: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(50),
})
export type ModelQuery = z.infer<typeof ModelQuerySchema>

export const ModelPageSchema = z.strictObject({
  models: z.array(ModelWithMetadataSchema),
  next_cursor: z.string().nullable(),
})
export type ModelPage = z.infer<typeof ModelPageSchema>

export const AttachmentSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  sha256: z.string(),
  mime: z.string(),
  size: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  origin: z.enum(['upload', 'generated']),
  created_at: z.number(),
})
export type Attachment = z.infer<typeof AttachmentSchema>
