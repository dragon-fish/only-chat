import type { ModelMessage, AssistantModelMessage, UserModelMessage, ToolModelMessage } from 'ai'
import type { SharedV4ProviderReference } from '@ai-sdk/provider'
import type { AnthropicProviderOptions } from '@ai-sdk/anthropic'
import type { GoogleVertexImageModelOptions } from '@ai-sdk/google-vertex'
import type { OpenAIResponsesProviderOptions } from '@ai-sdk/openai'
import type { OpenAICompatibleProviderOptions } from '@ai-sdk/openai-compatible'
import type { Message, ModelCapabilities, Protocol, ReasoningEffort, SessionParams } from '@/shared/models'
import type { Part, ProviderOptions } from '@/shared/parts'

export const COMPAT_PROVIDER_NAME = 'compat'

/**
 * How one attachment travels to the model: as the provider's own short-lived file pointer, or as
 * raw bytes inlined into the request (spec §5.6). Both are the AI SDK's own tagged file-data shapes.
 */
export interface AttachmentInput {
  mime: string
  data:
    | { type: 'reference'; reference: SharedV4ProviderReference }
    | { type: 'data'; data: Uint8Array }
}

export interface BuildInput {
  protocol: Protocol
  systemPrompt: string | null
  /** Root → leaf. The last element is the user message being answered. */
  path: Message[]
  attachments: ReadonlyMap<number, AttachmentInput>
}

const ANTHROPIC_CACHE = { anthropic: { cacheControl: { type: 'ephemeral' } } } as const

type UserPart = Extract<UserModelMessage['content'], unknown[]>[number]
type AssistantPart = Extract<AssistantModelMessage['content'], unknown[]>[number]
type ToolPart = ToolModelMessage['content'][number]

function userParts(parts: Part[], attachments: ReadonlyMap<number, AttachmentInput>): UserPart[] {
  const out: UserPart[] = []
  for (const p of parts) {
    if (p.type === 'text') {
      out.push({ type: 'text', text: p.text })
    } else if (p.type === 'image') {
      const att = attachments.get(p.attachment_id)
      if (!att) throw new Error(`attachment ${p.attachment_id} input not provided`)
      out.push({ type: 'file', mediaType: att.mime, data: att.data })
    }
    // reasoning / tool parts never appear on user messages
  }
  return out
}

/** What the AI SDK calls provider options, on a model message part or on the request itself. */
export type SdkProviderOptions = NonNullable<AssistantModelMessage['providerOptions']>

/**
 * Adds the stored metadata verbatim, and only when there is some, so parts stay byte-comparable.
 * The one cast is honest: stored metadata is opaque provider JSON we never author or inspect.
 */
function withOptions<T extends object>(
  part: T,
  providerOptions: ProviderOptions | undefined,
): T | (T & { providerOptions: SdkProviderOptions }) {
  return providerOptions ? { ...part, providerOptions: providerOptions as SdkProviderOptions } : part
}

function assistantParts(parts: Part[]): { assistant: AssistantPart[]; tool: ToolPart[] } {
  const assistant: AssistantPart[] = []
  const tool: ToolPart[] = []
  for (const p of parts) {
    switch (p.type) {
      case 'text':
        // An empty block still matters when it carries a thought signature to replay.
        if (p.text.length === 0 && !p.providerOptions) break
        assistant.push(withOptions({ type: 'text', text: p.text }, p.providerOptions))
        break
      case 'reasoning':
        // Every protocol replays reasoning: the adapter turns it into `reasoning_content`, a thinking
        // signature, an encrypted item or a thought signature (spec §6.2).
        if (p.text.length === 0 && !p.providerOptions) break
        assistant.push(withOptions({ type: 'reasoning', text: p.text }, p.providerOptions))
        break
      case 'tool_call':
        assistant.push(withOptions({ type: 'tool-call', toolCallId: p.id, toolName: p.name, input: p.args }, p.providerOptions))
        break
      case 'tool_result':
        tool.push({ type: 'tool-result', toolCallId: p.call_id, toolName: p.name, output: { type: 'json', value: p.content as never } })
        break
      case 'image':
        // Generated images are not replayed to the model in MVP. `requiredAttachmentIds` below is
        // the other half of that decision: it must skip exactly what this branch drops.
        break
    }
  }
  return { assistant, tool }
}

/**
 * Which attachments `buildModelMessages` will actually ask for, given the same path. Pure, and
 * deliberately next to the builder: "which attachments does the request need?" and "which ones does
 * it use?" have to be one answer, or the caller resolves bytes for parts that are never sent.
 *
 * Only user images qualify today, because `assistantParts` drops generated ones. Resolving those
 * too would read them out of R2 on every later turn — the quadratic re-read spec §5.6 exists to
 * remove — upload model output to the provider's Files API, and fail the whole turn on a missing R2
 * object that nothing in the request needed.
 */
export function requiredAttachmentIds(path: readonly Message[]): Set<number> {
  const ids = new Set<number>()
  for (const m of path) {
    if (m.role !== 'user') continue
    for (const p of m.parts) if (p.type === 'image') ids.add(p.attachment_id)
  }
  return ids
}

/**
 * Pure. Same input → byte-identical output, whether the parts came from memory or from D1.
 * Nothing request-specific may ever be added here (see spec §7.2).
 *
 * Callers must pass `allowSystemInMessages: true` to streamText; the system prompt is emitted as a
 * system message so Anthropic cache breakpoints can attach to it. The option defaults to false,
 * which rejects a `role: 'system'` message inside `messages`.
 */
export function buildModelMessages(input: BuildInput): ModelMessage[] {
  const { protocol, systemPrompt, path, attachments } = input
  const out: ModelMessage[] = []
  const cache = protocol === 'anthropic'

  if (systemPrompt !== null && systemPrompt.length > 0) {
    out.push(cache
      ? { role: 'system', content: systemPrompt, providerOptions: ANTHROPIC_CACHE }
      : { role: 'system', content: systemPrompt })
  }

  const lastUserIndex = path.map((m) => m.role).lastIndexOf('user')

  path.forEach((m, i) => {
    if (m.role === 'user') {
      const content = userParts(m.parts, attachments)
      out.push(cache && i === lastUserIndex
        ? { role: 'user', content, providerOptions: ANTHROPIC_CACHE }
        : { role: 'user', content })
      return
    }
    const { assistant, tool } = assistantParts(m.parts)
    if (assistant.length > 0) out.push({ role: 'assistant', content: assistant })
    if (tool.length > 0) out.push({ role: 'tool', content: tool })
  })

  return out
}

const ANTHROPIC_THINKING = { type: 'adaptive', display: 'summarized' } as const

/**
 * Gemini's `thinkingConfig`, reached through the only google-vertex export that carries it:
 * `GoogleVertexImageModelOptions` is declared as `Omit<GoogleLanguageModelOptions,
 * 'responseModalities'>` (@ai-sdk/google-vertex@5.0.75 dist/index.d.ts:37), and `@ai-sdk/google` is
 * not a direct dependency of this repo.
 */
type GeminiThinkingOptions = Pick<GoogleVertexImageModelOptions, 'thinkingConfig'>
type GeminiThinkingLevel = NonNullable<NonNullable<GeminiThinkingOptions['thinkingConfig']>['thinkingLevel']>
type AnthropicEffort = NonNullable<AnthropicProviderOptions['effort']>

/**
 * The reasoning levels each protocol actually accepts, taken from the installed SDK's own enums so
 * the compiler — not a comment — is what keeps these lists honest. Our `ReasoningEffort` is wider
 * than both: Anthropic rejects `minimal` and `ultra`, Gemini rejects `xhigh`, `max` and `ultra`.
 */
const ANTHROPIC_EFFORTS: readonly AnthropicEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const GEMINI_THINKING_LEVELS: readonly GeminiThinkingLevel[] = ['minimal', 'low', 'medium', 'high']

/**
 * Gemini's image output modality. This is the one option literal here the installed SDK's types
 * cannot check: `GoogleVertexImageModelOptions` is `Omit<GoogleLanguageModelOptions,
 * 'responseModalities'>` (@ai-sdk/google-vertex@5.0.75 dist/index.d.ts:37), and `@ai-sdk/google` —
 * which declares it as `("TEXT" | "IMAGE")[]` (@ai-sdk/google@4.0.63 dist/index.d.ts:19) — is not a
 * direct dependency of this repo.
 */
const GEMINI_IMAGE_MODALITIES = { responseModalities: ['TEXT', 'IMAGE'] }

/** A level the protocol cannot express is simply not sent; the request stays a reasoning request. */
function accept<T extends ReasoningEffort>(levels: readonly T[], effort: ReasoningEffort | undefined): T | undefined {
  return levels.find((level) => level === effort)
}

/**
 * Maps the two independent reasoning settings onto one protocol's options (spec §5.4).
 *
 * Enabled and effort never imply each other: `reasoning_enabled !== false` on a reasoning model means
 * on, and a `null` effort is explicit Auto — enabled, with the protocol's summary or thoughts output
 * requested but no effort sent. An explicit "off" value is only ever sent to a model that declares it
 * can be turned off; otherwise the field is omitted rather than filled with a value the model would
 * not honor. Every branch's literal is checked against the provider SDK's own options type.
 */
export function buildProviderOptions(
  protocol: Protocol,
  params: SessionParams | null,
  caps: ModelCapabilities,
): SdkProviderOptions {
  const enabled = Boolean(caps.reasoning) && params?.reasoning_enabled !== false
  const requested = enabled ? (params?.reasoning_effort ?? undefined) : undefined
  const declared = caps.reasoning_efforts
  // A model only receives a level it declares. No declaration at all means "undeclared", not
  // "nothing allowed", so an effort survives models that never listed their levels (spec §4.4).
  const effort = requested === undefined || !declared?.length || declared.includes(requested) ? requested : undefined
  const disable = !enabled && Boolean(caps.reasoning_can_disable)
  switch (protocol) {
    case 'openai-responses': {
      // `store: false` is unconditional: encrypted reasoning items are only returned without storage.
      const reasoning: OpenAIResponsesProviderOptions = enabled
        ? { reasoningSummary: 'auto', ...(effort ? { reasoningEffort: effort } : {}) }
        : disable ? { reasoningEffort: 'none' } : {}
      return { openai: { store: false, ...reasoning } satisfies OpenAIResponsesProviderOptions }
    }
    case 'openai-completions':
      // The compatible protocol has no disable value; Auto sends no effort at all.
      return effort ? { [COMPAT_PROVIDER_NAME]: { reasoningEffort: effort } satisfies OpenAICompatibleProviderOptions } : {}
    case 'anthropic': {
      if (!enabled) return disable ? { anthropic: { thinking: { type: 'disabled' } } satisfies AnthropicProviderOptions } : {}
      const accepted = accept(ANTHROPIC_EFFORTS, effort)
      return { anthropic: {
        thinking: ANTHROPIC_THINKING,
        ...(accepted ? { effort: accepted } : {}),
      } satisfies AnthropicProviderOptions }
    }
    // Both Gemini protocols share the same reasoning mapping; only auth and URLs differ (spec §5.5).
    case 'vertex':
    case 'vertex-compatible': {
      // Image output is asked for only from a model that declares the capability (spec §4.4/§5.8);
      // it is never inferred from a model id, and it is independent of the reasoning settings.
      const image = caps.image_output ? GEMINI_IMAGE_MODALITIES : {}
      if (!enabled) {
        if (!disable) return caps.image_output ? { googleVertex: { ...image } } : {}
        const off = { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } } satisfies GeminiThinkingOptions
        return { googleVertex: { ...image, ...off } }
      }
      const level = accept(GEMINI_THINKING_LEVELS, effort)
      const thinking = {
        thinkingConfig: { includeThoughts: true, ...(level ? { thinkingLevel: level } : {}) },
      } satisfies GeminiThinkingOptions
      return { googleVertex: { ...image, ...thinking } }
    }
    // Protocols outside the built-ins (e.g. one registered by a test) get no provider options.
    default:
      return {}
  }
}
