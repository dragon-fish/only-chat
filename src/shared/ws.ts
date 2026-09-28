import { z } from 'zod'
import { PartSchema, PartsSchema } from './parts'
import {
  MessageSchema, MessageStatusSchema, PersistedStatusSchema, ProjectSchema, ConversationParamsSchema,
  ConversationPluginSettingsSchema, ConversationSchema, UsageSchema, UserSettingsSchema,
} from './models'
import { ModelRefSchema } from './model-ref'

const base = { request_id: z.string().optional() }

export const SendCommandSchema = z.object({
  type: z.literal('send'),
  ...base,
  conversation_id: z.number().int().nullable(),
  parent_id: z.number().int().nullable(),
  parts: PartsSchema.min(1),
  /** The provider/model actually used for this generation — always required, independent of any conversation override below. */
  provider_id: z.number().int(),
  model_id: z.string().min(1),
  /**
   * Conversation-init fields, used only when `conversation_id` is null (first message of a new conversation):
   * `project_id`, conversation prompt, conversation params overrides, and an optional conversation-level model
   * override. `conversation_provider_id`/`conversation_model_id` are the conversation's *persisted* model
   * override (maps to `conversations.provider_id`/`conversations.model_id`) — distinct from the required
   * `provider_id`/`model_id` above, which is only the model used for this turn's generation.
   * Missing/null means the conversation has no override and inherits from its Project (spec §3.2/§5.3).
   */
  project_id: z.number().int().nullable().optional(),
  system_prompt: z.string().nullable().optional(),
  params: ConversationParamsSchema.nullable().optional(),
  conversation_provider_id: z.number().int().nullable().optional(),
  conversation_model_id: z.string().nullable().optional(),
  /** Selected tool snapshot, used only when creating the first Conversation row. */
  tools: z.array(z.string()).optional(),
  tools_enabled: z.boolean().optional(),
  plugin_settings: ConversationPluginSettingsSchema.optional(),
})
/**
 * `provider_id`/`model_id` on `regenerate` and `edit` are the client's current model selection,
 * carried as a one-shot choice for this generation alone. Both commands need it: the hub's own
 * command layer for them is a *past* generation's model, which a fresh pick has to outrank.
 */
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
  provider_id: z.number().int().optional(),
  model_id: z.string().min(1).optional(),
})
export const StopCommandSchema = z.object({ type: z.literal('stop'), ...base, conversation_id: z.number().int() })
export const SwitchHeadCommandSchema = z.object({
  type: z.literal('switch_head'),
  ...base,
  conversation_id: z.number().int(),
  message_id: z.number().int(),
})
export const ConversationUpdateCommandSchema = z.object({
  type: z.literal('conversation.update'),
  ...base,
  conversation_id: z.number().int(),
  title: z.string().min(1).max(200).optional(),
  project_id: z.number().int().nullable().optional(),
  provider_id: z.number().int().nullable().optional(),
  model_id: z.string().nullable().optional(),
  system_prompt: z.string().nullable().optional(),
  params: ConversationParamsSchema.nullable().optional(),
  tools: z.array(z.string()).optional(),
  tools_enabled: z.boolean().optional(),
  /** Merged per plugin id: a plugin left out keeps what it had, a plugin named is replaced whole. */
  plugin_settings: ConversationPluginSettingsSchema.optional(),
})
export const ConversationDeleteCommandSchema = z.object({
  type: z.literal('conversation.delete'),
  ...base,
  conversation_id: z.number().int(),
})
export const ConversationSuggestTitleCommandSchema = z.object({
  type: z.literal('conversation.suggest_title'),
  // Required, not from `base`: this command is answered, and the answer has to find its caller.
  request_id: z.string().min(1),
  conversation_id: z.number().int(),
})
export const ConversationForkCommandSchema = z.object({
  type: z.literal('conversation.fork'),
  request_id: z.string().min(1),
  conversation_id: z.number().int(),
  message_id: z.number().int(),
})
export const SettingsUpdateCommandSchema = z.object({
  type: z.literal('settings.update'),
  ...base,
  settings: z.object({
    plugins: z.record(z.string(), z.boolean()).optional(),
    service_models: z.object({
      text: ModelRefSchema.nullable().optional(),
      image: ModelRefSchema.nullable().optional(),
      file_understanding: ModelRefSchema.nullable().optional(),
    }).optional(),
    /** `null` clears a prompt back to its default; see `mergeServicePrompts`. */
    service_prompts: z.object({
      conversation_title: z.string().nullable().optional(),
      file_understanding: z.string().refine(value => value.trim().length > 0, 'File understanding prompt cannot be blank').nullable().optional(),
    }).optional(),
  }),
})
export const ProjectCreateCommandSchema = z.object({
  type: z.literal('project.create'),
  ...base,
  name: z.string().min(1).max(200),
  icon_attachment_id: z.number().int().nullable().optional(),
  system_prompt: z.string().nullable().optional(),
  provider_id: z.number().int().nullable().optional(),
  model_id: z.string().nullable().optional(),
  params: ConversationParamsSchema.nullable().optional(),
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
  params: ConversationParamsSchema.nullable().optional(),
})
export const ProjectDeleteCommandSchema = z.object({
  type: z.literal('project.delete'),
  ...base,
  project_id: z.number().int(),
})
export const ToolRespondCommandSchema = z.strictObject({
  type: z.literal('tool.respond'),
  request_id: z.string().min(1),
  message_id: z.number().int(),
  call_id: z.string().min(1),
  /** Shaped by the tool being answered; the hub validates it through that tool's own protocol. */
  result: z.unknown(),
})
export const ToolContinueCommandSchema = z.strictObject({
  type: z.literal('tool.continue'),
  request_id: z.string().min(1),
  message_id: z.number().int(),
})
/**
 * Something to say while the turn is still running, held until the model can be told.
 *
 * Stashed rather than sent: a user message cannot be interleaved among tool results, so it waits
 * for the boundary between two steps. The hub owns the stash even though the composer displays it,
 * because withdrawing races the injection and only one side can be right about which won.
 */
export const InterjectCommandSchema = z.object({
  type: z.literal('interject'),
  ...base,
  conversation_id: z.number().int(),
  parts: PartsSchema,
})
/**
 * Stop the turn and say it now, rather than waiting for a boundary that may be far off.
 *
 * Interrupting creates the position it needs: a turn that ends is a place a user message may
 * follow. So this is an abort and an ordinary send, which is what someone would do by hand — done
 * atomically, and without the stash being lost in between.
 */
export const InterjectInterruptCommandSchema = z.object({
  type: z.literal('interject.interrupt'),
  ...base,
  conversation_id: z.number().int(),
  /** The turn this starts is a turn like any other, and needs a model the same way `send` does. */
  provider_id: z.number().int(),
  model_id: z.string().min(1),
})
/** Take it back, if the model has not been told yet. The reply carries what was held. */
export const InterjectWithdrawCommandSchema = z.object({
  type: z.literal('interject.withdraw'),
  ...base,
  conversation_id: z.number().int(),
})

/** A plugin's private frame to its server half; the core only routes it by plugin id. */
export const PluginCommandSchema = z.object({
  type: z.literal('plugin.command'),
  ...base,
  plugin: z.string().min(1),
  payload: z.unknown(),
})

export const WsCommandSchema = z.discriminatedUnion('type', [
  SendCommandSchema,
  RegenerateCommandSchema,
  EditCommandSchema,
  StopCommandSchema,
  SwitchHeadCommandSchema,
  ConversationUpdateCommandSchema,
  ConversationDeleteCommandSchema,
  ConversationForkCommandSchema,
  ConversationSuggestTitleCommandSchema,
  SettingsUpdateCommandSchema,
  ProjectCreateCommandSchema,
  ProjectUpdateCommandSchema,
  ProjectDeleteCommandSchema,
  ToolRespondCommandSchema,
  ToolContinueCommandSchema,
  InterjectCommandSchema,
  InterjectInterruptCommandSchema,
  InterjectWithdrawCommandSchema,
  PluginCommandSchema,
])
export type WsCommand = z.infer<typeof WsCommandSchema>
export type SendCommand = z.infer<typeof SendCommandSchema>
export type RegenerateCommand = z.infer<typeof RegenerateCommandSchema>
export type EditCommand = z.infer<typeof EditCommandSchema>

export const WsEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), inflight: z.array(MessageSchema) }),
  z.object({ type: z.literal('conversation.created'), conversation: ConversationSchema }),
  z.object({ type: z.literal('conversation.updated'), conversation: ConversationSchema }),
  z.object({ type: z.literal('conversation.deleted'), conversation_id: z.number().int() }),
  z.object({ type: z.literal('conversation.forked'), request_id: z.string(), conversation_id: z.number().int() }),
  z.object({ type: z.literal('message.created'), message: MessageSchema }),
  z.object({
    type: z.literal('message.delta'),
    message_id: z.number().int(),
    part_index: z.number().int(),
    kind: z.enum(['text', 'reasoning']),
    delta: z.string(),
  }),
  /**
   * What the stash holds now, for every device of this user. Empty means nothing is waiting —
   * either it was withdrawn, or the model has been told and it is a part of the turn instead.
   */
  z.object({
    type: z.literal('interject.stash'),
    conversation_id: z.number().int(),
    parts: PartsSchema,
  }),
  /**
   * The stash handed back, because the withdrawal beat the injection. Empty means it did not, and
   * the words are already part of the turn.
   *
   * No request id: a conversation has one stash, so there is nothing to correlate, and requiring
   * one only created a field the sender had to remember to fill.
   */
  z.object({
    type: z.literal('interject.withdrawn'),
    conversation_id: z.number().int(),
    parts: PartsSchema,
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
  z.object({ type: z.literal('head.changed'), conversation_id: z.number().int(), message_id: z.number().int() }),
  z.object({ type: z.literal('settings.updated'), settings: UserSettingsSchema }),
  /** `title` is null when the service model declined, timed out, or is no longer usable. */
  z.object({
    type: z.literal('conversation.title_suggested'),
    request_id: z.string(),
    conversation_id: z.number().int(),
    title: z.string().nullable(),
  }),
  z.object({ type: z.literal('project.created'), project: ProjectSchema }),
  z.object({ type: z.literal('project.updated'), project: ProjectSchema }),
  z.object({ type: z.literal('project.deleted'), project_id: z.number().int() }),
  z.object({ type: z.literal('error'), request_id: z.string().optional(), message: z.string() }),
  /** The server half of a plugin talking to its client half; opaque to everything in between. */
  z.object({ type: z.literal('plugin.event'), plugin: z.string(), payload: z.unknown() }),
  /**
   * Live output of a tool call still running. Never persisted: the finished tool result carries
   * whatever of it is worth keeping, so a reload shows the outcome and not the ticker.
   */
  z.object({ type: z.literal('tool.progress'), message_id: z.number().int(), call_id: z.string(), lines: z.array(z.string()) }),
])
export type WsEvent = z.infer<typeof WsEventSchema>
export type MessageStatus = z.infer<typeof MessageStatusSchema>

export function parseCommand(raw: string): WsCommand {
  return WsCommandSchema.parse(JSON.parse(raw))
}

export function encodeEvent(event: WsEvent): string {
  return JSON.stringify(event)
}
