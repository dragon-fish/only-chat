import type { Context } from 'cordis'
import { createOpenAIFiles } from '../files/openai'
import { createFileAwareResponsesModel } from '../files/references'
import { RESPONSES_PROVIDER_NAME } from '../responses-reasoning'
import { observedProviderFetch } from '../observability'
import { createOpenAIImagesClient } from '../images/openai'

export const responsesProtocol = {
  name: 'llm-responses',
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.llm.register('responses', {
      createModel(_provider, providerInterface, model, apiKey, trace) {
        const base = providerInterface.base_url.replace(/\/+$/, '')
        const fetch = trace ? observedProviderFetch(trace, apiKey) : undefined
        return createFileAwareResponsesModel({ name: RESPONSES_PROVIDER_NAME, url: `${base}/responses`, apiKey, ...(fetch ? { fetch } : {}) }, model.model_id)
      },
      createFiles(provider, providerInterface, apiKey) {
        return createOpenAIFiles({ baseURL: providerInterface.base_url, apiKey, credentialVersion: provider.credential_version })
      },
      createImages(provider, providerInterface, apiKey) {
        return createOpenAIImagesClient(providerInterface.base_url, apiKey, {
          referenceMode: provider.models_dev_provider_id === 'volcengine' ? 'generation-json' : 'multipart-edits',
        })
      },
    })
  },
}
