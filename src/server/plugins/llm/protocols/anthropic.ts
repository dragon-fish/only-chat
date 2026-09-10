import type { Context } from 'cordis'
import type { LlmProtocolAdapter } from '../index'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createAnthropicFiles } from '../files/anthropic'

export const anthropicAdapter: LlmProtocolAdapter = {
  createModel(_provider, providerInterface, model, apiKey) {
    const p = createAnthropic({ baseURL: providerInterface.base_url, apiKey })
    return p(model.model_id)
  },
  createFiles(provider, providerInterface, apiKey) {
    return createAnthropicFiles({ baseURL: providerInterface.base_url, apiKey, credentialVersion: provider.credential_version })
  },
}

export const anthropicProtocol = {
  name: 'llm-anthropic',
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.llm.register('anthropic', anthropicAdapter)
  },
}
