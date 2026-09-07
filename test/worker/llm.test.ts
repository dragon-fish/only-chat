import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import type { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import type { UserHub } from '@/server/index'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import { splitVertexCompatibleModelId } from '@/server/plugins/llm/protocols/vertex-compatible'
import type { ModelRow, ProviderInterfaceRow, ProviderRow } from '@/server/db/schema'
import { streamText, type LanguageModel } from 'ai'
import { PartAccumulator } from '@/server/plugins/llm/accumulator'
import { buildModelMessages, buildProviderOptions } from '@/server/plugins/llm/messages'
import type { Message } from '@/shared/models'
import type { Part } from '@/shared/parts'
import { deepseekReasoningItem, deepseekResponsesBody, deepseekResponsesStream } from '../fixtures/deepseek-responses-stream'

/** `LanguageModel` also admits a bare gateway model id; our factories never return one. */
function built(m: LanguageModel): Exclude<LanguageModel, string> {
  if (typeof m === 'string') throw new Error(`expected a model object, got the model id ${m}`)
  return m
}

const model: ModelRow = {
  id: 1, provider_id: 1, model_id: 'test-model', display_name: 'x', capabilities: {}, pricing: null, enabled: true, sort: 0,
  interface_id: null, metadata_override: {}, metadata_resolved: {}, catalog_matches: { operator: null, lab: null, global: null },
  search_name: '', lab_id: null, supports_image_input: false, supports_image_output: false,
  supports_reasoning: false, supports_tools: false, context_limit: null, output_limit: null,
}

async function provider(
  key: string | null,
): Promise<ProviderRow> {
  return {
    id: 1, user_id: 1, name: 'p', protocol: 'vertex', base_url: 'https://unused.example/legacy',
    api_key: key ? await encryptSecret(env.KEY_ENCRYPTION_SECRET, key) : null, extra: null, enabled: true,
    native_files: false, created_at: 0,
    credential_version: 1, default_interface_id: null, models_dev_provider_id: null, models_dev_provider_source: null,
  }
}

function providerInterface(protocol: ProviderInterfaceRow['protocol'], base_url = 'https://example.com/v1'): ProviderInterfaceRow {
  return { id: 1, provider_id: 1, protocol, base_url, native_files: false, created_at: 0 }
}

/** The hub-side cordis root only lives inside a UserHub DO, so run these assertions in one. */
function inHub<R>(fn: (ctx: Context) => Promise<R>): Promise<R> {
  return runInDurableObject(env.USER_HUB.getByName('llm-test'), (instance: UserHub) => fn(instance.app))
}

/**
 * Build the model for real and stream one turn against a stubbed global fetch, so the assertions
 * see the request the AI SDK actually produced rather than a hand-rolled imitation of it.
 */
async function captureStreamRequest(p: ProviderRow, selected: ProviderInterfaceRow, m: ModelRow): Promise<{ url: string; headers: Headers; body: unknown }> {
  let captured: { url: string; headers: Headers; body: unknown } | undefined
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init)
    captured = { url: request.url, headers: request.headers, body: await request.json() }
    return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  await inHub(async (ctx) => {
    const lm = built(await ctx.llm.createModel(p, selected, m))
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
  it('builds all supported interfaces using their selected protocol instead of legacy provider fields', async () => {
    await inHub(async (ctx) => {
      for (const p of ['chat-completions', 'responses', 'anthropic', 'vertex-compatible'] as const) expect(ctx.llm.has(p)).toBe(true)

      const compat = built(await ctx.llm.createModel(await provider('k'), providerInterface('chat-completions'), model))
      expect(compat.provider).toBe('compat.chat')
      expect(compat.modelId).toBe('test-model')

      const responses = built(await ctx.llm.createModel(await provider('k'), providerInterface('responses'), model))
      expect(responses.modelId).toBe('test-model')

      const anthropic = built(await ctx.llm.createModel(await provider('k'), providerInterface('anthropic'), model))
      expect(anthropic.provider).toBe('anthropic.messages')

      // The publisher half of the id belongs in the URL, so only the model half reaches the SDK.
      const compatible = built(await ctx.llm.createModel(await provider('k'), providerInterface('vertex-compatible'), { ...model, model_id: 'google/gemini-2.5-pro' }))
      expect(compatible.provider).toBe('google.vertex.chat')
      expect(compatible.modelId).toBe('gemini-2.5-pro')
    })
  })

  it('rejects a missing key', async () => {
    await inHub(async (ctx) => {
      await expect(ctx.llm.createModel(await provider(null), providerInterface('anthropic'), model)).rejects.toThrow(/api key/i)
    })
  })

  it('rejects native Vertex and legacy protocol names', async () => {
    await inHub(async (ctx) => {
      for (const protocol of ['vertex', 'openai-responses', 'openai-completions']) {
        await expect(ctx.llm.createModel(await provider('k'), { ...providerInterface('responses'), protocol: protocol as never }, model))
          .rejects.toThrow(/no adapter/)
      }
    })
  })

  it('rejects an interface or model owned by a different provider', async () => {
    await inHub(async (ctx) => {
      const p = await provider('k')
      await expect(ctx.llm.createModel(p, { ...providerInterface('responses'), provider_id: 2 }, model)).rejects.toThrow(/provider/)
      await expect(ctx.llm.createModel(p, providerInterface('responses'), { ...model, provider_id: 2 })).rejects.toThrow(/provider/)
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

describe('responses protocol', () => {
  it.each(['https://api.deepseek.com', 'https://api.deepseek.com///', 'https://gateway.example/api/v1/'])('posts to the exact configured Responses endpoint (%s)', async (base) => {
    const request = await captureStreamRequest(await provider('test-key'), providerInterface('responses', base), model)
    expect(request.url).toBe(`${base.replace(/\/+$/, '')}/responses`)
    expect(request.headers.get('authorization')).toBe('Bearer test-key')
    expect(request.body).toMatchObject({ model: 'test-model' })
  })

  it('preserves full non-stream reasoning, metadata and item order', async () => {
    await inHub(async ctx => {
      const lm = built(await ctx.llm.createModel(await provider('k'), providerInterface('responses'), model))
      vi.stubGlobal('fetch', async () => Response.json(deepseekResponsesBody))
      try {
        const result = await lm.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] })
        expect(result.content.map(part => part.type)).toEqual(['reasoning', 'tool-call', 'text'])
        expect(result.content[0]).toEqual({
          type: 'reasoning', text: 'complete reasoning', providerMetadata: { responses: {
            itemId: 'rs_fixture', reasoningSummary: deepseekReasoningItem.summary,
            reasoningContent: deepseekReasoningItem.content, reasoningEncryptedContent: 'fixture-encrypted-state',
          } },
        })
      } finally { vi.unstubAllGlobals() }
    })
  })

  it('receives full Responses SSE through the registered adapter without requesting a summary', async () => {
    await inHub(async ctx => {
      const lm = await ctx.llm.createModel(await provider('k'), providerInterface('responses'), model)
      let requestBody: unknown
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = await new Request(input as RequestInfo, init).json()
        return deepseekResponsesStream()
      })
      try {
        const acc = new PartAccumulator()
        const result = streamText({ model: lm, prompt: 'fixture', providerOptions: buildProviderOptions('responses', { reasoning_effort: 'high' }, { reasoning: true }) })
        for await (const part of result.stream) {
          if (part.type === 'error') throw part.error
          acc.apply(part)
        }
        expect(requestBody).toMatchObject({ reasoning: { effort: 'high' } })
        expect((requestBody as { reasoning: object }).reasoning).not.toHaveProperty('summary')
        expect(acc.parts.map(part => part.type)).toEqual(['reasoning', 'tool_call', 'text'])
        expect(acc.parts[0]).toMatchObject({ type: 'reasoning', text: 'complete reasoning', providerOptions: { responses: { itemId: 'rs_fixture' } } })
      } finally { vi.unstubAllGlobals() }
    })
  })
})

describe('chat-completions reasoning', () => {
  it('receives reasoning_content and replays it when the next request disables new reasoning', async () => {
    await inHub(async ctx => {
      const lm = await ctx.llm.createModel(await provider('k'), providerInterface('chat-completions'), model)
      const requests: Array<{ reasoning_effort?: string; messages: Array<{ role: string; reasoning_content?: string; content: unknown }> }> = []
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(await new Request(input as RequestInfo, init).json())
        const chunk = (delta: object, finish_reason: string | null = null) => ({ id: 'chat_fixture', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason }] })
        return new Response([
          chunk({ role: 'assistant', reasoning_content: 'complete ' }), chunk({ reasoning_content: 'reasoning' }),
          chunk({ content: 'fixture answer' }), chunk({}, 'stop'),
        ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      })
      try {
        const acc = new PartAccumulator()
        for await (const part of streamText({ model: lm, prompt: 'first' }).stream) {
          if (part.type === 'error') throw part.error
          acc.apply(part)
        }
        const persisted: Part[] = JSON.parse(JSON.stringify(acc.parts))
        expect(persisted).toEqual([{ type: 'reasoning', text: 'complete reasoning' }, { type: 'text', text: 'fixture answer' }])
        const message: Message = { id: 1, session_id: 1, parent_id: null, seq: 1, role: 'assistant', parts: persisted, provider_id: 1, model_id: model.model_id, usage: null, status: 'done', error: null, created_at: 0 }
        const messages = buildModelMessages({ protocol: 'chat-completions', systemPrompt: null, path: [message], attachments: new Map() })
        const providerOptions = buildProviderOptions('chat-completions', { reasoning_enabled: false }, { reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'high'] }] })
        for await (const part of streamText({ model: lm, messages, providerOptions }).stream) if (part.type === 'error') throw part.error
        expect(requests[1]).toMatchObject({ reasoning_effort: 'none', messages: [{ role: 'assistant', reasoning_content: 'complete reasoning', content: 'fixture answer' }] })
      } finally { vi.unstubAllGlobals() }
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
    const p = await provider('test-key')
    const request = await captureStreamRequest(p, providerInterface('vertex-compatible', 'https://zenmux.ai/api/vertex-ai'), { ...model, model_id: 'google/gemini-2.5-pro' })

    const url = new URL(request.url)
    expect(`${url.origin}${url.pathname}`).toBe('https://zenmux.ai/api/vertex-ai/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent')
    // The AI SDK's Gemini streaming path always appends this; the assertion above pins the rest.
    expect(url.searchParams.get('alt')).toBe('sse')
    expect(request.headers.get('authorization')).toBe('Bearer test-key')
    expect(request.headers.has('x-goog-api-key')).toBe(false)
  })

  it('strips trailing slashes from the base URL without re-appending a provider path', async () => {
    const p = await provider('test-key')
    const request = await captureStreamRequest(p, providerInterface('vertex-compatible', 'https://zenmux.ai/api/vertex-ai///'), { ...model, model_id: 'google/gemini-2.5-pro' })
    expect(new URL(request.url).pathname).toBe('/api/vertex-ai/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent')
  })

  it('keeps every slash after the first inside the model segment', async () => {
    // Only the first slash names the publisher; the rest stay in the model segment, which spec
    // §5.5 fixes at `/publishers/{publisher}/models/{model}` however many slashes it contains.
    const p = await provider('test-key')
    const request = await captureStreamRequest(p, providerInterface('vertex-compatible', 'https://zenmux.ai/api/vertex-ai'), { ...model, model_id: 'meta/llama/3.1-405b' })
    expect(new URL(request.url).pathname).toBe('/api/vertex-ai/v1/publishers/meta/models/llama/3.1-405b:streamGenerateContent')
  })

  it('refuses to build a model from an id with no publisher', async () => {
    await inHub(async (ctx) => {
      const p = await provider('test-key')
      await expect(ctx.llm.createModel(p, providerInterface('vertex-compatible'), { ...model, model_id: 'gemini-2.5-pro' })).rejects.toThrow(/publisher\/model/)
    })
  })
})
