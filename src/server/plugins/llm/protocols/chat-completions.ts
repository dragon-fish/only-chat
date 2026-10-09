import type { Context } from 'cordis'
import type { LlmProtocolAdapter } from '../index'
import { COMPAT_PROVIDER_NAME } from '../messages'
import { createOpenAIFiles } from '../files/openai'
import { createFileAwareChatModel } from '../files/references'
import { dashscopeAudioFetch } from './dashscope-audio'
import { observedProviderFetch } from '../observability'
import { createOpenAIImagesClient } from '../images/openai'
import { withHeaders } from '../credentials'

export const chatCompletionsAdapter: LlmProtocolAdapter = {
  createModel(provider, providerInterface, model, { apiKey, headers }, trace) {
    const send = withHeaders(headers, providerInterface.base_url)
    return createFileAwareChatModel({
      name: COMPAT_PROVIDER_NAME,
      baseURL: providerInterface.base_url,
      apiKey,
      includeUsage: true,
      fetch: dashscopeAudioFetch(providerInterface.base_url, trace ? observedProviderFetch(trace, apiKey, send) : send),
    }, model.model_id, {
      fileReferenceStyle: provider.models_dev_provider_id === 'deepseek' ? 'flat' : 'nested',
    })
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

export const chatCompletionsProtocol = {
  name: 'llm-chat-completions',
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.llm.register('chat-completions', chatCompletionsAdapter)
  },
}
