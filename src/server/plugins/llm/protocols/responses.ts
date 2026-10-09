import type { Context } from 'cordis'
import type { LlmProtocolAdapter } from '../index'
import { createOpenAIFiles } from '../files/openai'
import { createFileAwareResponsesModel } from '../files/references'
import { RESPONSES_PROVIDER_NAME } from '../responses-reasoning'
import { observedProviderFetch } from '../observability'
import { createOpenAIImagesClient } from '../images/openai'
import { withHeaders } from '../credentials'

export const responsesAdapter: LlmProtocolAdapter = {
  createModel(_provider, providerInterface, model, { apiKey, headers }, trace) {
    const base = providerInterface.base_url.replace(/\/+$/, '')
    const send = withHeaders(headers, base)
    const fetch = trace ? observedProviderFetch(trace, apiKey, send) : send
    return createFileAwareResponsesModel({ name: RESPONSES_PROVIDER_NAME, url: `${base}/responses`, apiKey, fetch }, model.model_id)
  },
  createFiles(provider, providerInterface, { apiKey, headers }) {
    return createOpenAIFiles({ baseURL: providerInterface.base_url, apiKey, headers, credentialVersion: provider.credential_version })
  },
  createImages(provider, providerInterface, { apiKey, headers }) {
    return createOpenAIImagesClient(providerInterface.base_url, apiKey, {
      headers,
      referenceMode: provider.models_dev_provider_id === 'volcengine' ? 'generation-json' : 'multipart-edits',
    })
  },
}

export const responsesProtocol = {
  name: 'llm-responses',
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.llm.register('responses', responsesAdapter)
  },
}
