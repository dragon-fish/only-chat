import type { ConversationParams } from '@/shared/models'
import type { ProjectRow, ConversationRow } from '../../db/schema'

/** Which layer supplied the effective model; surfaced so errors can name it (spec §5.3). */
export type ModelSource = 'conversation' | 'project' | 'command'

export interface EffectiveModel {
  provider_id: number
  model_id: string
  source: ModelSource
}

export interface EffectiveConfig {
  systemPrompt: string | null
  /** `null` when no layer supplies a model; the caller must reject the generation. */
  model: EffectiveModel | null
  params: ConversationParams
}

/**
 * The conversation-level fields inheritance reads. A persisted `ConversationRow` satisfies it, and so does the
 * unsaved draft carried by the first `send` of a new conversation — which is what lets the model be
 * validated before any row is written.
 */
export type ConversationConfigSource = Pick<ConversationRow, 'system_prompt' | 'provider_id' | 'model_id' | 'params'>

export interface ResolveInput {
  conversation: ConversationConfigSource
  project?: ProjectRow
  /** The model this command asked for. Absent for commands that carry none, e.g. `edit`. */
  fallbackModel?: { provider_id: number; model_id: string }
}

/**
 * Pure. Computes a conversation's effective configuration by inheriting from its Project at generation
 * start (spec §3.2): Project settings are never copied into the conversation, so the same inputs always
 * produce byte-identical model messages.
 *
 * Presence, not truthiness, decides every field — `temperature: 0`, `reasoning_enabled: false` and
 * an empty prompt are real values, and a `null` `reasoning_effort` is explicit Auto rather than
 * "inherit". Neither prompt is trimmed or rewritten.
 */
export function resolveEffectiveConfig({ conversation, project, fallbackModel }: ResolveInput): EffectiveConfig {
  const prompts = [project?.system_prompt, conversation.system_prompt].filter((v): v is string => v !== null && v !== undefined)
  const model: EffectiveModel | null = conversation.provider_id !== null && conversation.model_id !== null
    ? { provider_id: conversation.provider_id, model_id: conversation.model_id, source: 'conversation' }
    : project?.provider_id != null && project.model_id != null
      ? { provider_id: project.provider_id, model_id: project.model_id, source: 'project' }
      : fallbackModel
        ? { ...fallbackModel, source: 'command' }
        : null
  return { systemPrompt: prompts.length ? prompts.join('\n\n') : null, model, params: { ...(project?.params ?? {}), ...(conversation.params ?? {}) } }
}
