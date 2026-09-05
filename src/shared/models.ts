import { z } from 'zod'
import { PartsSchema } from './parts'

export const ProtocolSchema = z.enum(['openai-completions', 'openai-responses', 'anthropic', 'vertex', 'vertex-compatible'])
export type Protocol = z.infer<typeof ProtocolSchema>

/** undefined = provider did not report; 0 = reported zero. Never collapse the two. */
export const UsageSchema = z.object({
  prompt: z.number().optional(),
  completion: z.number().optional(),
  cached: z.number().optional(),
  reasoning: z.number().optional(),
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

export const ModelCapabilitiesSchema = z.object({
  vision: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  tools: z.boolean().optional(),
  image_output: z.boolean().optional(),
  /** Whether the model accepts an explicit "off" reasoning state. */
  reasoning_can_disable: z.boolean().optional(),
  reasoning_efforts: z.array(ReasoningEffortSchema).optional(),
})
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>

export const ModelPricingSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cached: z.number().optional(),
})
export type ModelPricing = z.infer<typeof ModelPricingSchema>

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

/** Wire DTO: the encrypted key never leaves the server; `has_key` says whether one is stored. */
export const ProviderSchema = z.strictObject({
  id: z.number().int(),
  user_id: z.number().int(),
  name: z.string(),
  protocol: ProtocolSchema,
  base_url: z.string(),
  has_key: z.boolean(),
  extra: z.record(z.string(), z.unknown()).nullable(),
  enabled: z.boolean(),
  /** Whether this provider's Base URL supports its native Files API with upload-time expiry. Custom providers default false. */
  native_files: z.boolean(),
  created_at: z.number(),
})
export type Provider = z.infer<typeof ProviderSchema>

export const ModelSchema = z.object({
  id: z.number().int(),
  provider_id: z.number().int(),
  model_id: z.string(),
  display_name: z.string(),
  capabilities: ModelCapabilitiesSchema,
  pricing: ModelPricingSchema.nullable(),
  enabled: z.boolean(),
  sort: z.number().int(),
})
export type Model = z.infer<typeof ModelSchema>

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
