import { generateText } from 'ai'
import type { DB } from '../../db/client'
import type { ModelRow, ProviderInterfaceRow, ProviderRow } from '../../db/schema'
import { getModel, getProvider, getProviderInterface } from './conversations'
import { canServeAsServiceModel } from '@/shared/service-model'
import type { UserSettings } from '@/shared/models'
import type { Llm } from '../llm'
import { buildProviderOptions } from '../llm/messages'
import { renderServicePrompt, SERVICE_PROMPT_DEFAULTS, titleFromModelOutput } from '@/shared/service-prompts'

/** A title is a dozen words. Anything longer is the model ignoring its instruction, not thinking. */
const TITLE_MAX_OUTPUT_TOKENS = 64
/** The conversation is already usable; a slow namer must give up rather than keep a turn waiting. */
const TITLE_TIMEOUT_MS = 15_000

export interface ResolvedServiceModel {
  provider: ProviderRow
  providerInterface: ProviderInterfaceRow
  model: ModelRow
}

/**
 * The service model as it stands at this moment, or `null`.
 *
 * Resolved on every use rather than trusted from settings, because a setting outlives what it points
 * at: the model can be switched off, the provider disabled, the row deleted, or the catalog can
 * revise what the model can do. Every one of those reads as "not configured" — the jobs this model
 * does are conveniences, so the absence of one is never an error to report, only work not done.
 */
export async function resolveServiceModel(
  db: DB,
  userId: number,
  settings: UserSettings,
): Promise<ResolvedServiceModel | null> {
  const ref = settings.service_model
  if (!ref) return null

  const provider = await getProvider(db, ref.provider_id, userId)
  if (!provider?.enabled) return null
  const model = await getModel(db, ref.provider_id, ref.model_id, userId)
  if (!model?.enabled || !canServeAsServiceModel(model.metadata_resolved)) return null

  const interfaceId = model.interface_id ?? provider.default_interface_id
  if (interfaceId === null) return null
  const providerInterface = await getProviderInterface(db, interfaceId, userId)
  if (!providerInterface || providerInterface.provider_id !== provider.id) return null

  return { provider, providerInterface, model }
}

/**
 * Asks the service model for a conversation title, and returns `null` for every way that can fail.
 *
 * Nothing here is worth an error to the user: the conversation already carries a name taken from its
 * first words, and this only ever replaces it with a better one. A timeout, a disabled model, a
 * refusal, a paragraph instead of a title — each leaves what was already there.
 */
export async function suggestConversationTitle(
  deps: { db: DB, llm: Llm },
  userId: number,
  settings: UserSettings,
  firstUserMessage: string,
): Promise<string | null> {
  if (firstUserMessage.trim().length === 0) return null
  const resolved = await resolveServiceModel(deps.db, userId, settings)
  if (!resolved) return null

  const template = settings.service_prompts?.conversation_title ?? SERVICE_PROMPT_DEFAULTS.conversation_title
  const prompt = renderServicePrompt(template, { userMessages: [firstUserMessage] })

  try {
    const model = await deps.llm.createModel(resolved.provider, resolved.providerInterface, resolved.model)
    const result = await generateText({
      model,
      messages: [{ role: 'user', content: prompt }],
      // Reasoning is off for every service job. `buildProviderOptions` only emits the instruction to
      // models that declared they can be switched off, so this is inert on those that cannot.
      providerOptions: buildProviderOptions(
        resolved.providerInterface.protocol,
        { reasoning_enabled: false },
        resolved.model.metadata_resolved,
      ),
      maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
    })
    return titleFromModelOutput(result.text)
  }
  catch {
    // Deliberately silent, including the reason. Nobody asked for this call.
    return null
  }
}
