import type { Context } from 'cordis'
import { createOpenAI } from '@ai-sdk/openai'
import type { ProviderRow } from '../../../db/schema'

const client = (provider: ProviderRow, apiKey: string) => createOpenAI({ baseURL: provider.base_url, apiKey })

export const openaiResponsesProtocol = {
  name: 'llm-openai-responses',
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.llm.register('openai-responses', {
      createModel(provider, model, apiKey) {
        return client(provider, apiKey).responses(model.model_id)
      },
      // Reached only when the provider's `native_files` is on, so a compatible gateway that merely
      // speaks the Responses protocol is never probed for `/files` (spec §4.8).
      createFiles(provider, apiKey) {
        return client(provider, apiKey).files()
      },
    })
  },
}
