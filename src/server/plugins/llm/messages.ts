import type { ModelMessage, AssistantModelMessage, UserModelMessage, ToolModelMessage } from 'ai'
import type { SharedV4ProviderReference } from '@ai-sdk/provider'
import type { AnthropicProviderOptions } from '@ai-sdk/anthropic'
import type { GoogleVertexImageModelOptions } from '@ai-sdk/google-vertex'
import type { OpenResponsesLanguageModelOptions } from '@ai-sdk/open-responses'
import type { OpenAICompatibleProviderOptions } from '@ai-sdk/openai-compatible'
import type { Message, InterfaceProtocol, ReasoningEffort, ConversationParams } from '@/shared/models'
import type { ModelMetadata } from '@/shared/model-metadata'
import type { InterjectionPart, Part, ProviderOptions, ToolResultPart } from '@/shared/parts'
import { RESPONSES_PROVIDER_NAME, responsesReasoningReplayOptions } from './responses-reasoning'

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
  protocol: InterfaceProtocol
  systemPrompt: string | null
  /** Root → leaf. A tool continuation ends at the assistant message that now contains its result. */
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
 * Adds the selected metadata only when present, keeping deterministic message shapes.
 * The cast carries opaque provider JSON after any protocol-specific replay normalization.
 */
function withOptions<T extends object>(
  part: T,
  providerOptions: ProviderOptions | undefined,
): T | (T & { providerOptions: SdkProviderOptions }) {
  return providerOptions ? { ...part, providerOptions: providerOptions as SdkProviderOptions } : part
}

/** Namespaces read by the installed adapters, including their documented Gemini aliases. */
const METADATA_NAMESPACES: Record<InterfaceProtocol, readonly string[]> = {
  responses: [RESPONSES_PROVIDER_NAME],
  'chat-completions': [COMPAT_PROVIDER_NAME, 'openaiCompatible', 'google'],
  anthropic: ['anthropic'],
  'vertex-compatible': ['googleVertex', 'vertex', 'google'],
}

function targetOptions(protocol: InterfaceProtocol, stored: ProviderOptions | undefined): ProviderOptions | undefined {
  if (!stored) return undefined
  const entries = Object.entries(stored).filter(([namespace]) => METADATA_NAMESPACES[protocol]?.includes(namespace))
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/**
 * How an interjection is presented to the model, wherever it is being assembled.
 *
 * The note is not decoration. Without it the model meets a user message that appeared in the middle
 * of its own work with no explanation, and reads it as a new turn — answering it from the top
 * instead of folding it into what it was already doing.
 *
 * Shared by the live injection and by every later rebuild on purpose. Written in only one of those
 * places, a conversation would replay differently from how it happened, and the difference would
 * appear a turn later as the model contradicting itself.
 */
export function interjectionContent(
  part: InterjectionPart,
  attachments: ReadonlyMap<number, AttachmentInput>,
): UserPart[] {
  return [
    {
      type: 'text',
      text: '以下是用户在你这一轮工作进行期间发来的消息，它刚刚才进入对话。'
        + '这不是新的一轮提问：请把它纳入你当前正在做的事，必要时调整方向，然后继续。',
    },
    ...userParts(part.parts, attachments),
  ]
}

function assistantMessages(
  parts: Part[],
  protocol: InterfaceProtocol,
  attachments: ReadonlyMap<number, AttachmentInput>,
): Array<AssistantModelMessage | ToolModelMessage | UserModelMessage> {
  const out: Array<AssistantModelMessage | ToolModelMessage | UserModelMessage> = []
  /**
   * Calls this message answered. A `tool_use` with no result beside it cannot be followed by a
   * user message, so left alone it would make the request itself illegal — whatever the hub meant
   * to do about it, and whether or not the hub was even running when the row was written.
   *
   * Answered here instead of dropped. Dropping is legal too, but it hides the attempt: the model
   * would not see that it had reached for something and got nothing, which is context it can act
   * on. What it gets is the call it made and an outcome that is true of every reason there might
   * be — interrupted, never dispatched, still running somewhere nobody is listening.
   *
   * Not called an error. An error is a tool that ran and failed, and none of these did: they were
   * cut short. Told the tool failed, a model concludes the tool is unreliable and stops choosing
   * it, which is the wrong lesson from a turn its own user ended.
   *
   * Written nowhere. That is what makes a late result simple: a tool that could not be aborted and
   * finishes anyway is stored as an ordinary result, the next assembly uses it instead of this,
   * and there is no race over which of the two owns the row because only one of them was ever in
   * it. The cost is a prefix cache that rebuilds from this point, which is the cheaper half of the
   * trade by a wide margin.
   */
  const answered = new Set(
    parts.filter((part): part is ToolResultPart => part.type === 'tool_result').map(part => part.call_id),
  )
  let assistant: AssistantPart[] = []
  let tool: ToolPart[] = []
  const flushAssistant = () => {
    if (assistant.length > 0) out.push({ role: 'assistant', content: assistant })
    assistant = []
  }
  const flushTool = () => {
    if (tool.length > 0) out.push({ role: 'tool', content: tool })
    tool = []
  }
  const appendAssistant = (part: AssistantPart) => { flushTool(); assistant.push(part) }
  for (const p of parts) {
    const options = targetOptions(protocol, 'providerOptions' in p ? p.providerOptions : undefined)
    switch (p.type) {
      case 'text':
        // An empty block still matters when it carries a thought signature to replay.
        if (p.text.length === 0 && !options) break
        appendAssistant(withOptions({ type: 'text', text: p.text }, options))
        break
      case 'reasoning': {
        if (p.text.length === 0 && !options) break
        const reasoningOptions = protocol === 'responses' ? responsesReasoningReplayOptions(p.text, options) : options
        // Anthropic drops unsigned thinking. Foreign reasoning remains plain historical context;
        // never manufacture a signature or attach another protocol's opaque state.
        appendAssistant(protocol === 'anthropic' && !options?.anthropic
          ? { type: 'text', text: p.text }
          : withOptions({ type: 'reasoning', text: p.text }, reasoningOptions))
        break
      }
      case 'tool_call':
        appendAssistant(withOptions({ type: 'tool-call', toolCallId: p.id, toolName: p.name, input: p.args }, options))
        if (!answered.has(p.id)) {
          flushAssistant()
          tool.push({
            type: 'tool-result',
            toolCallId: p.id,
            toolName: p.name,
            output: { type: 'json', value: {
              interrupted: true,
              message: '这次调用没有完成，没有结果可用。可能是用户中途终止了这一轮，也可能是它根本没被派发出去。',
            } as never },
          })
        }
        break
      case 'tool_result':
        flushAssistant()
        tool.push(withOptions({ type: 'tool-result', toolCallId: p.call_id, toolName: p.name, output: { type: 'json', value: p.content as never } }, options))
        break
      case 'image':
        // Generated images are not replayed to the model in MVP. `requiredAttachmentIds` below is
        // the other half of that decision: it must skip exactly what this branch drops.
        break
      case 'interjection':
        // Back where the model met it: after the step that was running when it arrived, before the
        // one that answered it. Both halves flush first, or it would land inside them.
        flushAssistant()
        flushTool()
        out.push({ role: 'user', content: interjectionContent(p, attachments) })
        break
    }
  }
  flushAssistant()
  flushTool()
  return out
}

/**
 * Which attachments `buildModelMessages` will actually ask for, given the same path. Pure, and
 * deliberately next to the builder: "which attachments does the request need?" and "which ones does
 * it use?" have to be one answer, or the caller resolves bytes for parts that are never sent.
 *
 * Only user images qualify today, because `assistantMessages` drops generated ones. Resolving those
 * too would read them out of R2 on every later turn — the quadratic re-read spec §5.6 exists to
 * remove — upload model output to the provider's Files API, and fail the whole turn on a missing R2
 * object that nothing in the request needed.
 */
export function requiredAttachmentIds(path: readonly Message[]): Set<number> {
  const ids = new Set<number>()
  for (const m of path) {
    for (const p of m.parts) {
      if (m.role === 'user' && p.type === 'image') ids.add(p.attachment_id)
      // An interjection is the operator speaking, whichever message carries it.
      if (p.type === 'interjection') {
        for (const inner of p.parts) if (inner.type === 'image') ids.add(inner.attachment_id)
      }
    }
  }
  return ids
}

/**
 * What an interruption looks like from the model's side.
 *
 * Two shapes, and the difference is whether the abandoned turn left anything usable behind.
 *
 * It usually does — a tool had answered, or a sentence was already being written — and that work
 * is kept. Rolling back to before it would contradict the screen, which still shows the reply
 * stopping partway, and would throw away effort the model had already spent. What it needs is to
 * be told that the stop was deliberate, or it reads its own truncated paragraph as something it
 * chose to end there.
 *
 * Interrupted early enough and the turn has nothing to show. Then it is not a turn at all: the two
 * user messages around it belong together, and are joined with a note between them. They cannot be
 * left as two — Anthropic requires the roles to alternate, so a silent turn between them is an
 * error rather than an oddity.
 */
const INTERRUPTED_NOTE = '上面那轮回复没有说完，是用户在生成途中主动打断的，不是模型自己停在那里的。'
  + '已经做完的部分仍然有效，下面是用户接着说的话。'

const RESENT_NOTE = '（用户在这里打断了一次生成，紧接着又说了下面这些。两段是连着发的，中间没有模型的回复。）'

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
  /** Carried onto the next user message: a note about the turn that came before it. */
  let pending: string | null = null
  /** Set when the turn in between said nothing, so the user messages around it are one message. */
  let joinToPrevious = false

  path.forEach((m, i) => {
    if (m.role === 'user') {
      const said = userParts(m.parts, attachments)
      const content: UserPart[] = pending === null ? said : [{ type: 'text', text: pending }, ...said]
      pending = null

      const previous = joinToPrevious ? out.at(-1) : undefined
      joinToPrevious = false
      if (previous && previous.role === 'user' && Array.isArray(previous.content)) {
        previous.content = [...previous.content, ...content]
        if (cache && i === lastUserIndex) previous.providerOptions = ANTHROPIC_CACHE
        return
      }

      out.push(cache && i === lastUserIndex
        ? { role: 'user', content, providerOptions: ANTHROPIC_CACHE }
        : { role: 'user', content })
      return
    }

    const said = assistantMessages(m.parts, protocol, attachments)
    if (said.length === 0) {
      // Interrupted before it could say anything. There is no turn here to put between two user
      // messages, and leaving a gap would break the alternation Anthropic insists on.
      if (m.status === 'aborted') { pending = RESENT_NOTE; joinToPrevious = true }
      return
    }
    out.push(...said)
    if (m.status === 'aborted') pending = INTERRUPTED_NOTE
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
 * Reasoning settings affect only this request. Resolved catalog metadata declares model support;
 * neither these options nor the current capability can remove stored reasoning from history.
 */
export function buildProviderOptions(
  protocol: InterfaceProtocol,
  params: ConversationParams | null,
  metadata: ModelMetadata,
): SdkProviderOptions {
  const enabled = metadata.reasoning === true && params?.reasoning_enabled !== false
  const requested = enabled ? (params?.reasoning_effort ?? undefined) : undefined
  const options = metadata.reasoning_options ?? []
  const declared = options.flatMap(option => option.type === 'effort' ? option.values ?? [] : [])
  // A model only receives a level it declares. No declaration at all means "undeclared", not
  // "nothing allowed", so an effort survives models that never listed their levels (spec §4.4).
  const effort = requested === undefined || declared.length === 0 || declared.includes(requested) ? requested : undefined
  const disable = metadata.reasoning === true && params?.reasoning_enabled === false
    && (options.some(option => option.type === 'toggle') || declared.includes('none'))
  switch (protocol) {
    case 'responses': {
      const value = disable ? 'none' : effort
      return value ? { [RESPONSES_PROVIDER_NAME]: { reasoningEffort: value } satisfies OpenResponsesLanguageModelOptions } : {}
    }
    case 'chat-completions': {
      const value = disable ? 'none' : effort
      return value ? { [COMPAT_PROVIDER_NAME]: { reasoningEffort: value } satisfies OpenAICompatibleProviderOptions } : {}
    }
    case 'anthropic': {
      if (!enabled) return disable ? { anthropic: { thinking: { type: 'disabled' } } satisfies AnthropicProviderOptions } : {}
      const accepted = accept(ANTHROPIC_EFFORTS, effort)
      return { anthropic: {
        thinking: ANTHROPIC_THINKING,
        ...(accepted ? { effort: accepted } : {}),
      } satisfies AnthropicProviderOptions }
    }
    case 'vertex-compatible': {
      // Image output is asked for only from a model that declares the capability (spec §4.4/§5.8);
      // it is never inferred from a model id, and it is independent of the reasoning settings.
      const hasImageOutput = metadata.modalities?.output.includes('image') === true
      const image = hasImageOutput ? GEMINI_IMAGE_MODALITIES : {}
      if (!enabled) {
        if (!disable) return hasImageOutput ? { googleVertex: { ...image } } : {}
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
