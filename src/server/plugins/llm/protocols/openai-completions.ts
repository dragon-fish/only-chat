import type { Context } from 'cordis'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { COMPAT_PROVIDER_NAME } from '../messages'

export const openaiCompletionsProtocol = {
  name: 'llm-openai-completions',
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.llm.register('openai-completions', {
      createModel(provider, model, apiKey) {
        const p = createOpenAICompatible({
          name: COMPAT_PROVIDER_NAME,
          baseURL: provider.base_url,
          apiKey,
          includeUsage: true,
        })
        return p.chatModel(model.model_id)
      },
    })
  },
}
