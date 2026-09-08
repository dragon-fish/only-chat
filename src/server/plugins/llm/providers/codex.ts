import type { Context } from 'cordis'
import type { LanguageModel } from 'ai'
import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { FetchFunction } from '@ai-sdk/provider-utils'
import type { ModelRow, ProviderInterfaceRow, ProviderRow } from '@/server/db/schema'
import { CodexReconnectRequiredError, type Codex } from '../../codex'
import { CODEX_API_BASE_URL, CODEX_ORIGINATOR } from '../../codex/constants'
import { createFileAwareResponsesModel } from '../files/references'
import { observedProviderFetch, type LlmRequestTrace } from '../observability'
import { readResponsesReasoningDelta, RESPONSES_PROVIDER_NAME } from '../responses-reasoning'

function modelError(signal?: AbortSignal, cause?: unknown): Error {
  if (signal?.aborted) return new DOMException('Codex Responses request aborted', 'AbortError')
  // Only this application error may change the public instruction; never reuse its properties.
  return new Error(cause instanceof CodexReconnectRequiredError ? 'Codex reconnect required' : 'Codex Responses request failed')
}

/** SDK failures can retain prompts, raw events, and upstream errors even after HTTP succeeds. */
function sanitizeModelErrors(model: LanguageModelV4): LanguageModelV4 {
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    async doGenerate(options) {
      try { return await model.doGenerate(options) } catch (cause) { throw modelError(options.abortSignal, cause) }
    },
    async doStream(options) {
      try {
        const result = await model.doStream(options)
        const reader = result.stream.getReader()
        return { ...result, stream: new ReadableStream<LanguageModelV4StreamPart>({
          async pull(controller) {
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) {
                  reader.releaseLock()
                  controller.close()
                  return
                }
                // Only reasoning deltas are consumed as raw input; SDK raw errors precede error chunks.
                if (value.type === 'raw' && !readResponsesReasoningDelta(value.rawValue)) continue
                if (value.type === 'error') controller.enqueue({ type: 'error', error: modelError(options.abortSignal) })
                else if (value.type === 'finish' && value.finishReason.unified === 'error') {
                  controller.enqueue({ ...value, finishReason: { unified: 'error', raw: undefined } })
                } else controller.enqueue(value)
                return
              }
            } catch {
              reader.releaseLock()
              controller.error(modelError(options.abortSignal))
            }
          },
          async cancel(reason) {
            try { await reader.cancel(reason) } catch { throw modelError(options.abortSignal) }
            finally { reader.releaseLock() }
          },
        }) }
      } catch (cause) { throw modelError(options.abortSignal, cause) }
    },
  }
}

export function normalizeCodexResponsesBody(body: string): string {
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { throw new Error('Codex Responses request body must be a JSON object') }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Codex Responses request body must be a JSON object')
  const request = parsed as Record<string, unknown>
  request.store = false
  request.instructions ??= ''
  request.include = [...new Set([...(Array.isArray(request.include) ? request.include : []), 'reasoning.encrypted_content'])]
  // Codex replays local history and encrypted reasoning; remote state is never retained.
  for (const key of ['previous_response_id', 'conversation', 'generate', 'prompt_cache_retention', 'safety_identifier', 'stream_options', 'temperature', 'top_p', 'max_output_tokens']) delete request[key]
  return JSON.stringify(request)
}

export async function createCodexModel(codex: Codex, provider: ProviderRow, _providerInterface: ProviderInterfaceRow, model: ModelRow, trace?: LlmRequestTrace): Promise<LanguageModel> {
  const credentials = await codex.getValidCredentials(provider.id)
  const codexFetch: FetchFunction = async (_input, init) => {
    if (typeof init?.body !== 'string') throw new Error('Codex Responses request body must be a JSON object')
    const body = normalizeCodexResponsesBody(init.body)
    const send = async (current: typeof credentials) => {
      const headers = new Headers(init.headers)
      headers.set('Authorization', `Bearer ${current.bundle.accessToken}`)
      headers.set('ChatGPT-Account-ID', current.bundle.accountId)
      headers.set('Originator', CODEX_ORIGINATOR)
      const safeFetch: FetchFunction = async (input, options) => {
        try { return await fetch(input, options) } catch {
          // Network errors may contain tokens or upstream bodies; sanitize before observability.
          throw new Error('Codex Responses request failed')
        }
      }
      const request = trace ? observedProviderFetch(trace, current.bundle.accessToken, safeFetch) : safeFetch
      return request(`${CODEX_API_BASE_URL}/responses`, { ...init, body, headers })
    }
    let response = await send(await codex.getValidCredentials(provider.id))
    if (response.status === 401) {
      await response.body?.cancel()
      response = await send(await codex.getValidCredentials(provider.id, true))
    }
    if (!response.ok) {
      await response.body?.cancel()
      // SDK HTTP errors retain requestBodyValues; a fixed error keeps prompts out of failure logs.
      throw new Error(`Codex Responses request failed (${response.status})`)
    }
    return response
  }
  return sanitizeModelErrors(createFileAwareResponsesModel({ name: RESPONSES_PROVIDER_NAME, url: `${CODEX_API_BASE_URL}/responses`, apiKey: credentials.bundle.accessToken, fetch: codexFetch }, model.model_id))
}

export const codexProvider = {
  name: 'llm-codex',
  inject: ['llm', 'codex'],
  apply(ctx: Context) {
    ctx.llm.registerProvider('codex-oauth', { createModel: (provider, selected, model, trace) => createCodexModel(ctx.codex, provider, selected, model, trace) })
  },
}
