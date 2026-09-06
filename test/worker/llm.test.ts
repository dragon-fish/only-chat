import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import type { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import type { UserHub } from '@/server/index'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import { splitVertexCompatibleModelId } from '@/server/plugins/llm/protocols/vertex-compatible'
import type { ModelRow, ProviderRow } from '@/server/db/schema'
import type { LanguageModel } from 'ai'

/** `LanguageModel` also admits a bare gateway model id; our factories never return one. */
function built(m: LanguageModel): Exclude<LanguageModel, string> {
  if (typeof m === 'string') throw new Error(`expected a model object, got the model id ${m}`)
  return m
}

const model: ModelRow = { id: 1, provider_id: 1, model_id: 'test-model', display_name: 'x', capabilities: {}, pricing: null, enabled: true, sort: 0 }

async function provider(
  protocol: ProviderRow['protocol'],
  key: string | null,
  extra: Record<string, unknown> | null = null,
  base_url = 'https://example.com/v1',
): Promise<ProviderRow> {
  return {
    id: 1, user_id: 1, name: 'p', protocol, base_url,
    api_key: key ? await encryptSecret(env.KEY_ENCRYPTION_SECRET, key) : null, extra, enabled: true,
    native_files: false, created_at: 0,
  }
}

/** The hub-side cordis root only lives inside a UserHub DO, so run these assertions in one. */
function inHub<R>(fn: (ctx: Context) => Promise<R>): Promise<R> {
  return runInDurableObject(env.USER_HUB.getByName('llm-test'), (instance: UserHub) => fn(instance.app))
}

/**
 * Build the model for real and stream one turn against a stubbed global fetch, so the assertions
 * see the request the AI SDK actually produced rather than a hand-rolled imitation of it.
 */
async function captureStreamRequest(p: ProviderRow, m: ModelRow): Promise<Request> {
  let captured: Request | undefined
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = new Request(input as RequestInfo, init)
    return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  await inHub(async (ctx) => {
    const lm = built(await ctx.llm.createModel(p, m))
    vi.stubGlobal('fetch', stub)
    try {
      await lm.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    } finally {
      vi.unstubAllGlobals()
    }
  })
  if (!captured) throw new Error('the adapter never issued a request')
  return captured
}

describe('Llm service', () => {
  it('registers the five protocols and builds models without network', async () => {
    await inHub(async (ctx) => {
      for (const p of ['openai-completions', 'openai-responses', 'anthropic', 'vertex', 'vertex-compatible'] as const) expect(ctx.llm.has(p)).toBe(true)

      const compat = built(await ctx.llm.createModel(await provider('openai-completions', 'k'), model))
      expect(compat.provider).toBe('compat.chat')
      expect(compat.modelId).toBe('test-model')

      const responses = built(await ctx.llm.createModel(await provider('openai-responses', 'k'), model))
      expect(responses.provider).toBe('openai.responses')

      const anthropic = built(await ctx.llm.createModel(await provider('anthropic', 'k'), model))
      expect(anthropic.provider).toBe('anthropic.messages')

      const sa = JSON.stringify({ client_email: 'a@b', private_key: 'PEM', private_key_id: 'kid' })
      const vertex = built(await ctx.llm.createModel(await provider('vertex', sa, { project: 'proj', location: 'us-central1' }), model))
      expect(vertex.provider).toBe('google.vertex.chat')

      // The publisher half of the id belongs in the URL, so only the model half reaches the SDK.
      const compatible = built(await ctx.llm.createModel(await provider('vertex-compatible', 'k'), { ...model, model_id: 'google/gemini-2.5-pro' }))
      expect(compatible.provider).toBe('google.vertex.chat')
      expect(compatible.modelId).toBe('gemini-2.5-pro')
    })
  })

  it('rejects a missing key', async () => {
    await inHub(async (ctx) => {
      await expect(ctx.llm.createModel(await provider('anthropic', null), model)).rejects.toThrow(/api key/i)
    })
  })

  it('lets a test register a custom protocol and disposes it with the caller', async () => {
    await inHub(async (ctx) => {
      const fiber = await ctx.plugin({ name: 'mock-protocol', inject: ['llm'], apply(c) { c.llm.register('mock', { createModel: () => ({ provider: 'mock' }) as never }) } })
      expect(ctx.llm.has('mock')).toBe(true)
      await fiber.dispose()
      expect(ctx.llm.has('mock')).toBe(false)
    })
  })
})

describe('splitVertexCompatibleModelId', () => {
  it('splits on the first slash only', () => {
    expect(splitVertexCompatibleModelId('google/gemini-2.5-pro')).toEqual({ publisher: 'google', model: 'gemini-2.5-pro' })
    expect(splitVertexCompatibleModelId('meta/llama/3.1-405b')).toEqual({ publisher: 'meta', model: 'llama/3.1-405b' })
  })

  it('rejects ids that cannot address a publisher and a model', () => {
    for (const id of ['gemini-2.5-pro', '/gemini-2.5-pro', 'google/', '', '/']) {
      expect(() => splitVertexCompatibleModelId(id)).toThrow(/publisher\/model/)
    }
  })
})

describe('vertex-compatible protocol', () => {
  it('addresses the publisher path and authenticates with a bearer key alone', async () => {
    const p = await provider('vertex-compatible', 'test-key', null, 'https://zenmux.ai/api/vertex-ai')
    const request = await captureStreamRequest(p, { ...model, model_id: 'google/gemini-2.5-pro' })

    const url = new URL(request.url)
    expect(`${url.origin}${url.pathname}`).toBe('https://zenmux.ai/api/vertex-ai/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent')
    // The AI SDK's Gemini streaming path always appends this; the assertion above pins the rest.
    expect(url.searchParams.get('alt')).toBe('sse')
    expect(request.headers.get('authorization')).toBe('Bearer test-key')
    expect(request.headers.has('x-goog-api-key')).toBe(false)
  })

  it('strips trailing slashes from the base URL without re-appending a provider path', async () => {
    const p = await provider('vertex-compatible', 'test-key', null, 'https://zenmux.ai/api/vertex-ai///')
    const request = await captureStreamRequest(p, { ...model, model_id: 'google/gemini-2.5-pro' })
    expect(new URL(request.url).pathname).toBe('/api/vertex-ai/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent')
  })

  it('keeps every slash after the first inside the model segment', async () => {
    // Only the first slash names the publisher; the rest stay in the model segment, which spec
    // §5.5 fixes at `/publishers/{publisher}/models/{model}` however many slashes it contains.
    const p = await provider('vertex-compatible', 'test-key', null, 'https://zenmux.ai/api/vertex-ai')
    const request = await captureStreamRequest(p, { ...model, model_id: 'meta/llama/3.1-405b' })
    expect(new URL(request.url).pathname).toBe('/api/vertex-ai/v1/publishers/meta/models/llama/3.1-405b:streamGenerateContent')
  })

  it('refuses to build a model from an id with no publisher', async () => {
    await inHub(async (ctx) => {
      const p = await provider('vertex-compatible', 'test-key')
      await expect(ctx.llm.createModel(p, { ...model, model_id: 'gemini-2.5-pro' })).rejects.toThrow(/publisher\/model/)
    })
  })
})
