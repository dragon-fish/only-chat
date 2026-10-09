import type { Context } from 'cordis'
import type { LlmProtocolAdapter } from '../index'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createAnthropicFiles } from '../files/anthropic'
import { withHeaders } from '../credentials'

export const anthropicAdapter: LlmProtocolAdapter = {
  createModel(_provider, providerInterface, model, { apiKey, headers }) {
    const p = createAnthropic({ baseURL: providerInterface.base_url, apiKey, fetch: withHeaders(headers, providerInterface.base_url) })
    return p(model.model_id)
  },
  createFiles(provider, providerInterface, { apiKey, headers }) {
    return createAnthropicFiles({ baseURL: providerInterface.base_url, apiKey, headers, credentialVersion: provider.credential_version })
  },
}

export const anthropicProtocol = {
  name: 'llm-anthropic',
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.llm.register('anthropic', anthropicAdapter)
  },
}
