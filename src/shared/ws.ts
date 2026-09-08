import { z } from 'zod'
import { PartSchema, PartsSchema } from './parts'
import {
  MessageSchema, MessageStatusSchema, PersistedStatusSchema, ProjectSchema, SessionParamsSchema,
  SessionSchema, UsageSchema, UserSettingsSchema,
} from './models'

const base = { request_id: z.string().optional() }

export const SendCommandSchema = z.object({
  type: z.literal('send'),
  ...base,
  session_id: z.number().int().nullable(),
  parent_id: z.number().int().nullable(),
  parts: PartsSchema.min(1),
  /** The provider/model actually used for this generation — always required, independent of any session override below. */
  provider_id: z.number().int(),
  model_id: z.string().min(1),
  /**
   * Session-init fields, used only when `session_id` is null (first message of a new session):
   * `project_id`, session prompt, session params overrides, and an optional session-level model
   * override. `session_provider_id`/`session_model_id` are the session's *persisted* model
   * override (maps to `sessions.provider_id`/`sessions.model_id`) — distinct from the required
   * `provider_id`/`model_id` above, which is only the model used for this turn's generation.
   * Missing/null means the session has no override and inherits from its Project (spec §3.2/§5.3).
   */
  project_id: z.number().int().nullable().optional(),
  system_prompt: z.string().nullable().optional(),
  params: SessionParamsSchema.nullable().optional(),
  session_provider_id: z.number().int().nullable().optional(),
  session_model_id: z.string().nullable().optional(),
})
export const RegenerateCommandSchema = z.object({
  type: z.literal('regenerate'),
  ...base,
  message_id: z.number().int(),
  provider_id: z.number().int().optional(),
  model_id: z.string().min(1).optional(),
})
export const EditCommandSchema = z.object({
  type: z.literal('edit'),
  ...base,
  message_id: z.number().int(),
  parts: PartsSchema.min(1),
})
export const StopCommandSchema = z.object({ type: z.literal('stop'), ...base, session_id: z.number().int() })
export const SwitchHeadCommandSchema = z.object({
  type: z.literal('switch_head'),
  ...base,
  session_id: z.number().int(),
  message_id: z.number().int(),
})
export const SessionUpdateCommandSchema = z.object({
  type: z.literal('session.update'),
  ...base,
  session_id: z.number().int(),
  title: z.string().min(1).max(200).optional(),
  project_id: z.number().int().nullable().optional(),
  provider_id: z.number().int().nullable().optional(),
  model_id: z.string().nullable().optional(),
  system_prompt: z.string().nullable().optional(),
  params: SessionParamsSchema.nullable().optional(),
})
export const SessionDeleteCommandSchema = z.object({
  type: z.literal('session.delete'),
  ...base,
  session_id: z.number().int(),
})
export const SessionForkCommandSchema = z.object({
  type: z.literal('session.fork'),
  request_id: z.string().min(1),
  session_id: z.number().int(),
  message_id: z.number().int(),
})
export const SettingsUpdateCommandSchema = z.object({
  type: z.literal('settings.update'),
  ...base,
  settings: z.object({ plugins: z.record(z.string(), z.boolean()).optional() }),
})
export const ProjectCreateCommandSchema = z.object({
  type: z.literal('project.create'),
  ...base,
  name: z.string().min(1).max(200),
  icon_attachment_id: z.number().int().nullable().optional(),
  system_prompt: z.string().nullable().optional(),
  provider_id: z.number().int().nullable().optional(),
  model_id: z.string().nullable().optional(),
  params: SessionParamsSchema.nullable().optional(),
})
export const ProjectUpdateCommandSchema = z.object({
  type: z.literal('project.update'),
  ...base,
  project_id: z.number().int(),
  name: z.string().min(1).max(200).optional(),
  icon_attachment_id: z.number().int().nullable().optional(),
  system_prompt: z.string().nullable().optional(),
  provider_id: z.number().int().nullable().optional(),
  model_id: z.string().nullable().optional(),
  params: SessionParamsSchema.nullable().optional(),
})
export const ProjectDeleteCommandSchema = z.object({
  type: z.literal('project.delete'),
  ...base,
  project_id: z.number().int(),
})

export const WsCommandSchema = z.discriminatedUnion('type', [
  SendCommandSchema,
  RegenerateCommandSchema,
  EditCommandSchema,
  StopCommandSchema,
  SwitchHeadCommandSchema,
  SessionUpdateCommandSchema,
  SessionDeleteCommandSchema,
  SessionForkCommandSchema,
  SettingsUpdateCommandSchema,
  ProjectCreateCommandSchema,
  ProjectUpdateCommandSchema,
  ProjectDeleteCommandSchema,
])
export type WsCommand = z.infer<typeof WsCommandSchema>
export type SendCommand = z.infer<typeof SendCommandSchema>

export const WsEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), inflight: z.array(MessageSchema) }),
  z.object({ type: z.literal('session.created'), session: SessionSchema }),
  z.object({ type: z.literal('session.updated'), session: SessionSchema }),
  z.object({ type: z.literal('session.deleted'), session_id: z.number().int() }),
  z.object({ type: z.literal('session.forked'), request_id: z.string(), session_id: z.number().int() }),
  z.object({ type: z.literal('message.created'), message: MessageSchema }),
  z.object({
    type: z.literal('message.delta'),
    message_id: z.number().int(),
    part_index: z.number().int(),
    kind: z.enum(['text', 'reasoning']),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('message.part'),
    message_id: z.number().int(),
    part_index: z.number().int(),
    part: PartSchema,
  }),
  z.object({
    type: z.literal('message.done'),
    message_id: z.number().int(),
    status: PersistedStatusSchema,
    usage: UsageSchema.nullable(),
    error: z.string().nullable(),
  }),
  z.object({ type: z.literal('head.changed'), session_id: z.number().int(), message_id: z.number().int() }),
  z.object({ type: z.literal('settings.updated'), settings: UserSettingsSchema }),
  z.object({ type: z.literal('project.created'), project: ProjectSchema }),
  z.object({ type: z.literal('project.updated'), project: ProjectSchema }),
  z.object({ type: z.literal('project.deleted'), project_id: z.number().int() }),
  z.object({ type: z.literal('error'), request_id: z.string().optional(), message: z.string() }),
])
export type WsEvent = z.infer<typeof WsEventSchema>
export type MessageStatus = z.infer<typeof MessageStatusSchema>

export function parseCommand(raw: string): WsCommand {
  return WsCommandSchema.parse(JSON.parse(raw))
}

export function encodeEvent(event: WsEvent): string {
  return JSON.stringify(event)
}
