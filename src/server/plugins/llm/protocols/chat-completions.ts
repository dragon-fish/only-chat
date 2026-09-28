import type { Context } from 'cordis'
import type { LlmProtocolAdapter } from '../index'
import { COMPAT_PROVIDER_NAME } from '../messages'
import { createOpenAIFiles } from '../files/openai'
import { createFileAwareChatModel } from '../files/references'
import { dashscopeAudioFetch } from './dashscope-audio'
import { observedProviderFetch } from '../observability'
import { createOpenAIImagesClient } from '../images/openai'

export const chatCompletionsAdapter: LlmProtocolAdapter = {
  createModel(provider, providerInterface, model, apiKey, trace) {
    const fetch = dashscopeAudioFetch(providerInterface.base_url, trace ? observedProviderFetch(trace, apiKey) : undefined)
    return createFileAwareChatModel({
      name: COMPAT_PROVIDER_NAME,
      baseURL: providerInterface.base_url,
      apiKey,
      includeUsage: true,
      ...(fetch ? { fetch } : {}),
    }, model.model_id, {
      fileReferenceStyle: provider.models_dev_provider_id === 'deepseek' ? 'flat' : 'nested',
    })
  },
  createFiles(provider, providerInterface, apiKey) {
    return createOpenAIFiles({ baseURL: providerInterface.base_url, apiKey, credentialVersion: provider.credential_version })
  },
  createImages(provider, providerInterface, apiKey) {
    return createOpenAIImagesClient(providerInterface.base_url, apiKey, {
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
