import type { Context } from 'cordis'
import { createOpenAIFiles } from '../files/openai'
import { createFileAwareResponsesModel } from '../files/references'
import { RESPONSES_PROVIDER_NAME } from '../responses-reasoning'

export const responsesProtocol = {
  name: 'llm-responses',
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.llm.register('responses', {
      createModel(_provider, providerInterface, model, apiKey) {
        const base = providerInterface.base_url.replace(/\/+$/, '')
        return createFileAwareResponsesModel({ name: RESPONSES_PROVIDER_NAME, url: `${base}/responses`, apiKey }, model.model_id)
      },
      createFiles(provider, providerInterface, apiKey) {
        return createOpenAIFiles({ baseURL: providerInterface.base_url, apiKey, credentialVersion: provider.credential_version })
      },
    })
  },
}
