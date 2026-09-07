import type { Context } from 'cordis'
import { createOpenResponses } from '@ai-sdk/open-responses'
import { createOpenAI } from '@ai-sdk/openai'
import { RESPONSES_PROVIDER_NAME } from '../messages'

export const responsesProtocol = {
  name: 'llm-responses',
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.llm.register('responses', {
      createModel(_provider, providerInterface, model, apiKey) {
        const base = providerInterface.base_url.replace(/\/+$/, '')
        return createOpenResponses({ name: RESPONSES_PROVIDER_NAME, url: `${base}/responses`, apiKey })(model.model_id)
      },
      createFiles(_provider, providerInterface, apiKey) {
        return createOpenAI({ baseURL: providerInterface.base_url, apiKey }).files()
      },
    })
  },
}
