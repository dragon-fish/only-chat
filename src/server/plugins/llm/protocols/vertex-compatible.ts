import type { Context } from 'cordis'
import { createGoogleVertex } from '@ai-sdk/google-vertex/edge'
import type { FetchFunction } from '@ai-sdk/provider-utils'

/**
 * Vertex-style gateways address models as `{publisher}/{model}`. Only the first slash separates
 * the two, so a model whose own name contains slashes survives intact.
 */
export function splitVertexCompatibleModelId(id: string): { publisher: string; model: string } {
  const slash = id.indexOf('/')
  if (slash <= 0 || slash === id.length - 1) throw new Error('Google model id must be publisher/model')
  return { publisher: id.slice(0, slash), model: id.slice(slash + 1) }
}

/**
 * `createGoogleVertex` wraps this in its Express Mode fetch, which has already stamped
 * `x-goog-api-key` onto the headers. Compatible gateways take an ordinary bearer token instead, so
 * Google's header is removed rather than merely accompanied.
 */
function bearerFetch(apiKey: string): FetchFunction {
  return (input, init) => {
    const headers = new Headers(init?.headers)
    headers.delete('x-goog-api-key')
    headers.set('Authorization', `Bearer ${apiKey}`)
    return fetch(input, { ...init, headers })
  }
}

export const vertexCompatibleProtocol = {
  name: 'llm-vertex-compatible',
  inject: ['llm'],
  apply(ctx: Context) {
    // No `createFiles`: a Vertex-compatible gateway exposes no Files API of its own (spec §5.6).
    ctx.llm.register('vertex-compatible', {
      createModel(_provider, providerInterface, model, apiKey) {
        // Express Mode is what routes requests through `bearerFetch`; without a key the SDK would
        // silently fall back to Google Cloud IAM, which this protocol never uses.
        if (!apiKey) throw new Error('vertex-compatible requires an API key')
        const { publisher, model: modelId } = splitVertexCompatibleModelId(model.model_id)
        // The Base URL is the deployer's to choose in full; only trailing slashes are removed.
        const baseURL = `${providerInterface.base_url.replace(/\/+$/, '')}/v1/publishers/${publisher}`
        const p = createGoogleVertex({ apiKey, baseURL, fetch: bearerFetch(apiKey) })
        // The SDK prefixes `models/` only for a slash-free id, treating anything else as a resource
        // path. Spec §5.5 fixes the shape at `/models/{model}`, so prefix it ourselves when the model
        // half carries slashes of its own.
        return p(modelId.includes('/') ? `models/${modelId}` : modelId)
      },
    })
  },
}
