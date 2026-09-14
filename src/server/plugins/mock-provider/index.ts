import type { Context } from 'cordis'
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Prompt, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { LlmProtocolAdapter } from '../llm/index'
import { anthropicAdapter } from '../llm/protocols/anthropic'
import { chatCompletionsAdapter } from '../llm/protocols/chat-completions'
import { responsesAdapter } from '../llm/protocols/responses'
import { vertexCompatibleAdapter } from '../llm/protocols/vertex-compatible'
import { isMockBaseUrl } from './constants'
import { buildMockScript, type MockScript } from './script'

/**
 * Whether this turn already ran a tool.
 *
 * The hub loops while the model keeps emitting tool calls, and the mock has no memory of its own: a
 * directive that produced a tool call would produce the same one on every step, up to the step cap.
 * Seeing a tool result in the prompt is how it knows the work is already done.
 */
export function toolResultCount(prompt: LanguageModelV4Prompt): number {
  // Only this turn counts. Scanning the whole prompt would see tool results from earlier turns and
  // resume a macro somewhere past its end for the rest of the conversation.
  let start = 0
  for (let index = prompt.length - 1; index >= 0; index--) {
    if (prompt[index]!.role === 'user') { start = index + 1; break }
  }
  // Counted, not merely detected: a macro hands out one segment per call, and which segment comes
  // next is exactly how many have already come back.
  let count = 0
  for (const message of prompt.slice(start)) {
    if (message.role === 'tool') count += message.content.length
    else if (message.role === 'assistant') count += message.content.filter(part => part.type === 'tool-result').length
  }
  return count
}

/** Whether this turn already ran a tool. Kept for callers that only need the question answered. */
export function hasToolResult(prompt: LanguageModelV4Prompt): boolean {
  return toolResultCount(prompt) > 0
}

/**
 * The directive lives in the newest thing the operator said; earlier turns are history the mock
 * ignores.
 *
 * The last text part, not all of them joined: the prompt builder prefixes a note to a user message
 * that followed an interruption, and joining would put that note where the macro should start.
 * Interruptions also merge several user messages into one, and only the newest carries the
 * directive.
 */
export function lastUserText(prompt: LanguageModelV4Prompt): string {
  for (let index = prompt.length - 1; index >= 0; index--) {
    const message = prompt[index]!
    if (message.role !== 'user') continue
    const texts = message.content.filter((part): part is { type: 'text', text: string } => part.type === 'text')
    return texts.at(-1)?.text ?? ''
  }
  return ''
}

function scriptStream(script: MockScript): ReadableStream<LanguageModelV4StreamPart> {
  let index = 0
  return new ReadableStream<LanguageModelV4StreamPart>({
    async pull(controller) {
      if (index >= script.parts.length) { controller.close(); return }
      const delayMs = script.delays[index] ?? 0
      if (delayMs > 0 && index > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
      controller.enqueue(script.parts[index]!)
      index += 1
    },
  })
}

function mockModel(provider: string, modelId: string): LanguageModelV4 {
  const scriptFor = (options: LanguageModelV4CallOptions) =>
    buildMockScript(lastUserText(options.prompt), { toolResults: toolResultCount(options.prompt) })
  return {
    specificationVersion: 'v4',
    provider,
    modelId,
    supportedUrls: {},
    async doStream(options) {
      return { stream: scriptStream(scriptFor(options)), request: {}, response: {} }
    },
    async doGenerate(options) {
      const script = scriptFor(options)
      const text = script.parts
        .filter((part): part is Extract<LanguageModelV4StreamPart, { type: 'text-delta' }> => part.type === 'text-delta')
        .map(part => part.delta)
        .join('')
      const finish = script.parts.at(-1)
      if (finish?.type !== 'finish') throw new Error('mock script has no finish part')
      return {
        content: text ? [{ type: 'text' as const, text }] : [],
        finishReason: finish.finishReason,
        usage: finish.usage,
        warnings: [],
      }
    },
  }
}

/** Serves mock interfaces locally and hands every other interface back to the real adapter. */
function mockable(adapter: LlmProtocolAdapter): LlmProtocolAdapter {
  return {
    ...adapter,
    createModel(provider, providerInterface, model, apiKey, trace) {
      if (!isMockBaseUrl(providerInterface.base_url)) {
        return adapter.createModel(provider, providerInterface, model, apiKey, trace)
      }
      return mockModel(`mock-${providerInterface.protocol}`, model.model_id)
    },
  }
}

/**
 * Local-development only: registered after the real protocol plugins so it replaces their
 * registrations with wrapped ones. Guard the `ctx.plugin` call with `import.meta.env.DEV` at the
 * call site so production builds tree-shake the whole module away.
 */
export const MockProviderPlugin = {
  name: 'mock-provider',
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.llm.register('responses', mockable(responsesAdapter))
    ctx.llm.register('chat-completions', mockable(chatCompletionsAdapter))
    ctx.llm.register('anthropic', mockable(anthropicAdapter))
    ctx.llm.register('vertex-compatible', mockable(vertexCompatibleAdapter))
  },
}
