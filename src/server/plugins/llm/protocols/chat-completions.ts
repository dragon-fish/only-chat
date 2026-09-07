import type { Context } from 'cordis'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { COMPAT_PROVIDER_NAME } from '../messages'

export const chatCompletionsProtocol = {
  name: 'llm-chat-completions',
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.llm.register('chat-completions', {
      createModel(_provider, providerInterface, model, apiKey) {
        const p = createOpenAICompatible({
          name: COMPAT_PROVIDER_NAME,
          baseURL: providerInterface.base_url,
          apiKey,
          includeUsage: true,
        })
        return p.chatModel(model.model_id)
      },
    })
  },
}
