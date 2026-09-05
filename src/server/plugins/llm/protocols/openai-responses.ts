import type { Context } from 'cordis'
import { createOpenAI } from '@ai-sdk/openai'

export const openaiResponsesProtocol = {
  name: 'llm-openai-responses',
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.llm.register('openai-responses', (provider, model, apiKey) => {
      const p = createOpenAI({ baseURL: provider.base_url, apiKey: apiKey ?? undefined })
      return p.responses(model.model_id)
    })
  },
}
