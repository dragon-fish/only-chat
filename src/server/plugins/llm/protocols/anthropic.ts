import type { Context } from 'cordis'
import { createAnthropic } from '@ai-sdk/anthropic'

export const anthropicProtocol = {
  name: 'llm-anthropic',
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.llm.register('anthropic', {
      createModel(provider, model, apiKey) {
        const p = createAnthropic({ baseURL: provider.base_url, apiKey })
        return p(model.model_id)
      },
    })
  },
}
