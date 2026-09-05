import type { ModelMessage, AssistantModelMessage, UserModelMessage, ToolModelMessage } from 'ai'
import type { Message, ModelCapabilities, Protocol, ReasoningEffort, SessionParams } from '@/shared/models'
import type { Part, ProviderOptions } from '@/shared/parts'

export const COMPAT_PROVIDER_NAME = 'compat'

export interface ImageBytes {
  bytes: Uint8Array
  mime: string
}

export interface BuildInput {
  protocol: Protocol
  systemPrompt: string | null
  /** Root → leaf. The last element is the user message being answered. */
  path: Message[]
  images: ReadonlyMap<number, ImageBytes>
}

const ANTHROPIC_CACHE = { anthropic: { cacheControl: { type: 'ephemeral' } } } as const

type UserPart = Extract<UserModelMessage['content'], unknown[]>[number]
type AssistantPart = Extract<AssistantModelMessage['content'], unknown[]>[number]
type ToolPart = ToolModelMessage['content'][number]

function userParts(parts: Part[], images: ReadonlyMap<number, ImageBytes>): UserPart[] {
  const out: UserPart[] = []
  for (const p of parts) {
    if (p.type === 'text') {
      out.push({ type: 'text', text: p.text })
    } else if (p.type === 'image') {
      const img = images.get(p.attachment_id)
      if (!img) throw new Error(`attachment ${p.attachment_id} bytes not provided`)
      out.push({ type: 'file', mediaType: img.mime, data: { type: 'data', data: img.bytes } })
    }
    // reasoning / tool parts never appear on user messages
  }
  return out
}

/** Adds the stored metadata verbatim, and only when there is some, so parts stay byte-comparable. */
function withOptions<T extends object>(part: T, providerOptions: ProviderOptions | undefined): T {
  return providerOptions ? { ...part, providerOptions: providerOptions as never } : part
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
        // Generated images are not replayed to the model in MVP.
        break
    }
  }
  return { assistant, tool }
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
  const { protocol, systemPrompt, path, images } = input
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
      const content = userParts(m.parts, images)
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
 * `@ai-sdk/anthropic@4.0.49` types the top-level `effort` as low | medium | high | xhigh | max
 * (dist/index.d.ts:267). Our slider also offers `minimal` and `ultra`, which Anthropic would reject,
 * so those levels are dropped and the request simply carries no effort (spec §5.4).
 */
const ANTHROPIC_EFFORTS: ReadonlySet<ReasoningEffort> = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/**
 * Maps the two independent reasoning settings onto one protocol's options (spec §5.4).
 *
 * Enabled and effort never imply each other: `reasoning_enabled !== false` on a reasoning model means
 * on, and a `null` effort is explicit Auto — enabled, with the protocol's summary or thoughts output
 * requested but no effort sent. An explicit "off" value is only ever sent to a model that declares it
 * can be turned off; otherwise the field is omitted rather than filled with a value the model would
 * not honor.
 */
export function buildProviderOptions(
  protocol: Protocol,
  params: SessionParams | null,
  caps: ModelCapabilities,
): ProviderOptions {
  const enabled = Boolean(caps.reasoning) && params?.reasoning_enabled !== false
  const effort = enabled ? (params?.reasoning_effort ?? undefined) : undefined
  const disable = !enabled && Boolean(caps.reasoning_can_disable)
  switch (protocol) {
    case 'openai-responses': {
      // `store: false` is unconditional: encrypted reasoning items are only returned without storage.
      const reasoning = enabled
        ? { reasoningSummary: 'auto', ...(effort ? { reasoningEffort: effort } : {}) }
        : disable ? { reasoningEffort: 'none' } : {}
      return { openai: { store: false, ...reasoning } }
    }
    case 'openai-completions':
      // The compatible protocol has no disable value; Auto sends no effort at all.
      return effort ? { [COMPAT_PROVIDER_NAME]: { reasoningEffort: effort } } : {}
    case 'anthropic': {
      if (!enabled) return disable ? { anthropic: { thinking: { type: 'disabled' } } } : {}
      const accepted = effort && ANTHROPIC_EFFORTS.has(effort) ? effort : undefined
      return { anthropic: { thinking: ANTHROPIC_THINKING, ...(accepted ? { effort: accepted } : {}) } }
    }
    // Both Gemini protocols share the same reasoning mapping; only auth and URLs differ (spec §5.5).
    case 'vertex':
    case 'vertex-compatible':
      if (!enabled) return disable ? { googleVertex: { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } } } : {}
      return { googleVertex: { thinkingConfig: { includeThoughts: true, ...(effort ? { thinkingLevel: effort } : {}) } } }
    // Protocols outside the built-ins (e.g. one registered by a test) get no provider options.
    default:
      return {}
  }
}
