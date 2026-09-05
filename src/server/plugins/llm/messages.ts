import type { ModelMessage, AssistantModelMessage, UserModelMessage, ToolModelMessage } from 'ai'
import type { Message, ModelCapabilities, Protocol, SessionParams } from '@/shared/models'
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

function assistantParts(parts: Part[], protocol: Protocol): { assistant: AssistantPart[]; tool: ToolPart[] } {
  const assistant: AssistantPart[] = []
  const tool: ToolPart[] = []
  for (const p of parts) {
    switch (p.type) {
      case 'text':
        if (p.text.length > 0) assistant.push({ type: 'text', text: p.text })
        break
      case 'reasoning':
        // openai-completions (openai-compatible endpoints) has nothing to replay and may reject unknown blocks.
        if (protocol === 'openai-completions') break
        if (p.text.length === 0 && !p.providerOptions) break
        assistant.push(p.providerOptions
          ? { type: 'reasoning', text: p.text, providerOptions: p.providerOptions as never }
          : { type: 'reasoning', text: p.text })
        break
      case 'tool_call':
        assistant.push({ type: 'tool-call', toolCallId: p.id, toolName: p.name, input: p.args })
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
    const { assistant, tool } = assistantParts(m.parts, protocol)
    if (assistant.length > 0) out.push({ role: 'assistant', content: assistant })
    if (tool.length > 0) out.push({ role: 'tool', content: tool })
  })

  return out
}

const ANTHROPIC_THINKING = { type: 'adaptive', display: 'summarized' } as const

export function buildProviderOptions(
  protocol: Protocol,
  params: SessionParams | null,
  caps: ModelCapabilities,
): ProviderOptions {
  const effort = caps.reasoning ? params?.reasoning_effort : undefined
  switch (protocol) {
    case 'openai-responses':
      return { openai: { store: false, ...(effort ? { reasoningEffort: effort, reasoningSummary: 'auto' } : {}) } }
    case 'openai-completions':
      return effort ? { [COMPAT_PROVIDER_NAME]: { reasoningEffort: effort } } : {}
    case 'anthropic':
      return effort ? { anthropic: { effort, thinking: ANTHROPIC_THINKING } } : {}
    case 'vertex':
      return effort ? { googleVertex: { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } } } : {}
    // Protocols outside the four built-ins (e.g. one registered by a test) get no provider options.
    default:
      return {}
  }
}
