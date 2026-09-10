import type { Context } from 'cordis'
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Prompt, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { LlmProtocolAdapter } from '../llm/index'
import { anthropicAdapter } from '../llm/protocols/anthropic'
import { chatCompletionsAdapter } from '../llm/protocols/chat-completions'
import { responsesAdapter } from '../llm/protocols/responses'
import { vertexCompatibleAdapter } from '../llm/protocols/vertex-compatible'
import { isMockBaseUrl } from './constants'
import { buildMockScript, type MockScript } from './script'

/** The directive lives in the newest user turn; earlier ones are history the mock ignores. */
export function lastUserText(prompt: LanguageModelV4Prompt): string {
  for (let index = prompt.length - 1; index >= 0; index--) {
    const message = prompt[index]!
    if (message.role !== 'user') continue
    return message.content
      .filter((part): part is { type: 'text', text: string } => part.type === 'text')
      .map(part => part.text)
      .join('')
  }
  return ''
}

function scriptStream(script: MockScript): ReadableStream<LanguageModelV4StreamPart> {
  let index = 0
  return new ReadableStream<LanguageModelV4StreamPart>({
    async pull(controller) {
      if (index >= script.parts.length) { controller.close(); return }
      if (script.delayMs > 0 && index > 0) await new Promise(resolve => setTimeout(resolve, script.delayMs))
      controller.enqueue(script.parts[index]!)
      index += 1
    },
  })
}

function mockModel(provider: string, modelId: string): LanguageModelV4 {
  const scriptFor = (options: LanguageModelV4CallOptions) => buildMockScript(lastUserText(options.prompt))
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
