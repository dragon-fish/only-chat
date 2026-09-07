import type { Context } from 'cordis'
import { COMPAT_PROVIDER_NAME } from '../messages'
import { createOpenAIFiles } from '../files/openai'
import { createFileAwareChatModel } from '../files/references'

export const chatCompletionsProtocol = {
  name: 'llm-chat-completions',
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.llm.register('chat-completions', {
      createModel(_provider, providerInterface, model, apiKey) {
        return createFileAwareChatModel({
          name: COMPAT_PROVIDER_NAME,
          baseURL: providerInterface.base_url,
          apiKey,
          includeUsage: true,
        }, model.model_id)
      },
      createFiles(provider, providerInterface, apiKey) {
        return createOpenAIFiles({ baseURL: providerInterface.base_url, apiKey, credentialVersion: provider.credential_version })
      },
    })
  },
}
