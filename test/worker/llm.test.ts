import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import type { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import type { UserHub } from '@/server/index'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import { splitVertexCompatibleModelId } from '@/server/plugins/llm/protocols/vertex-compatible'
import type { ModelRow, ProviderInterfaceRow, ProviderRow } from '@/server/db/schema'
import { streamText, type LanguageModel } from 'ai'
import type { LanguageModelV4 } from '@ai-sdk/provider'
import { PartAccumulator } from '@/server/plugins/llm/accumulator'
import { buildModelMessages, buildProviderOptions } from '@/server/plugins/llm/messages'
import type { Message } from '@/shared/models'
import type { Part } from '@/shared/parts'
import { deepseekReasoningItem, deepseekResponsesBody, deepseekResponsesStream } from '../fixtures/deepseek-responses-stream'
import { ensureTestUser } from './auth-helper'
import { connect } from './ws-helper'

/** `LanguageModel` also admits a bare gateway model id; our factories never return one. */
function built(m: LanguageModel): LanguageModelV4 {
  if (typeof m === 'string') throw new Error(`expected a model object, got the model id ${m}`)
  if (m.specificationVersion !== 'v4') throw new Error('expected a V4 model')
  return m
}

const model: ModelRow = {
  id: 1, provider_id: 1, model_id: 'test-model', enabled: true, sort: 0,
  interface_id: null, metadata_override: {}, metadata_resolved: {}, catalog_matches: { operator: null, lab: null, global: null },
  provider_metadata: {}, image_extra_body: {}, lab_id: null, supports_image_input: false, supports_image_output: false,
  supports_reasoning: false, supports_tools: false, context_limit: null, output_limit: null,
  manual_pinned: true, upstream_available: null,
}

async function provider(
  key: string | null,
): Promise<ProviderRow> {
  return {
    id: 1, user_id: 1, name: 'p',
    api_key: key ? await encryptSecret(env.KEY_ENCRYPTION_SECRET, key) : null, enabled: true, created_at: 0,
    credential_version: 1, default_interface_id: null, models_dev_provider_id: null, models_dev_provider_source: null,
    default_image_model_id: null, model_revision: 1,
  }
}

function providerInterface(protocol: ProviderInterfaceRow['protocol'], base_url = 'https://example.com/v1'): ProviderInterfaceRow {
  return { id: 1, provider_id: 1, protocol, base_url, native_files: false, created_at: 0 }
}

/** The hub-side cordis root only lives inside a UserHub DO, so run these assertions in one. */
async function inHub<R>(fn: (ctx: Context) => Promise<R>): Promise<R> {
  const socket = await connect(await ensureTestUser())
  try { return await runInDurableObject(env.USER_HUB.getByName('1'), (instance: UserHub) => fn(instance.app)) }
  finally { socket.ws.close() }
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
  it.each(['responses', 'chat-completions'] as const)('exposes one Images client through the %s interface', async protocol => {
    await inHub(async ctx => {
      let request: Request | undefined
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        request = new Request(input, init)
        return Response.json({ data: [{ b64_json: btoa('\u0089PNG') }] })
      })
      try {
        const selected = providerInterface(protocol, 'https://gateway.example/v1/')
        expect(ctx.llm.hasImages(selected)).toBe(true)
        const images = await ctx.llm.createImages(await provider('image-key'), selected)
        await images.generate({
          modelId: 'image-model', prompt: 'otter', references: [], params: { count: 1, size: null }, idempotencyKey: 'run',
        })
        expect(request?.url).toBe('https://gateway.example/v1/images/generations')
        expect(request?.headers.get('authorization')).toBe('Bearer image-key')
      } finally { vi.unstubAllGlobals() }
    })
  })

  it.each(['anthropic', 'vertex-compatible'] as const)('does not advertise Images for the %s interface', async protocol => {
    await inHub(async ctx => expect(ctx.llm.hasImages(providerInterface(protocol))).toBe(false))
  })
  it('shares OpenAI Files scope between both OpenAI interfaces and isolates Anthropic', async () => {
    await inHub(async ctx => {
      const p = { ...await provider('files-key'), credential_version: 9 }
      for (const protocol of ['responses', 'chat-completions', 'anthropic'] as const) {
        const selected = { ...providerInterface(protocol, 'https://gateway.example/api/v1///'), native_files: true }
        expect(ctx.llm.hasFiles(selected)).toBe(true)
        const scoped = await ctx.llm.createFiles(p, selected)
        expect(scoped).toMatchObject({ family: protocol === 'anthropic' ? 'anthropic' : 'openai', baseURL: 'https://gateway.example/api/v1', credentialVersion: 9 })
        expect(scoped.files.deleteFile).toBeTypeOf('function')
      }
    })
  })

  it('does not offer Files for Vertex, a disabled interface, or an interface from another provider', async () => {
    await inHub(async ctx => {
      const p = await provider('files-key')
      const vertex = { ...providerInterface('vertex-compatible'), native_files: true }
      expect(ctx.llm.hasFiles(vertex)).toBe(false)
      await expect(ctx.llm.createFiles(p, vertex)).rejects.toThrow(/no Files API/)
      expect(ctx.llm.hasFiles(providerInterface('responses'))).toBe(false)
      await expect(ctx.llm.createFiles(p, providerInterface('responses'))).rejects.toThrow(/disabled/)
      await expect(ctx.llm.createFiles(p, { ...providerInterface('responses'), native_files: true, provider_id: 2 })).rejects.toThrow(/provider/)
    })
  })

  it('builds all supported interfaces using their selected protocol', async () => {
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
  it('sends native document and image IDs through the actual SDK while retaining full streamed reasoning', async () => {
    await inHub(async ctx => {
      const lm = await ctx.llm.createModel(await provider('k'), providerInterface('responses'), model)
      let requestBody: unknown
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = await new Request(input, init).json()
        return deepseekResponsesStream()
      })
      try {
        const acc = new PartAccumulator()
        for await (const part of streamText({ model: lm, include: { rawChunks: true }, messages: [{ role: 'user', content: [
          { type: 'text', text: 'read these' },
          { type: 'file', mediaType: 'application/pdf', data: { type: 'reference', reference: { openai: 'file-doc' } } },
          { type: 'file', mediaType: 'image/png', data: { type: 'reference', reference: { openai: 'file-image' } } },
          { type: 'file', mediaType: 'image/png', data: { type: 'url', url: new URL('https://example.com/image.png?token=a%2Fb#keep') } },
          { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AQIDBA==' } },
        ] }] }).stream) {
          if (part.type === 'error') throw part.error
          acc.apply(part)
        }
        expect(requestBody).toMatchObject({ input: [{ role: 'user', content: [
          { type: 'input_text', text: 'read these' },
          { type: 'input_file', file_id: 'file-doc' },
          { type: 'input_image', file_id: 'file-image' },
          { type: 'input_image', image_url: 'https://example.com/image.png?token=a%2Fb#keep' },
          { type: 'input_image', image_url: 'data:image/png;base64,AQIDBA==' },
        ] }] })
        expect(acc.parts[0]).toMatchObject({ type: 'reasoning', text: 'complete reasoning', providerOptions: { responses: { itemId: 'rs_fixture', reasoningContent: deepseekReasoningItem.content } } })
      } finally { vi.unstubAllGlobals() }
    })
  })

  it('keeps native file maps local to concurrent non-stream SDK calls and leaves prompts unchanged', async () => {
    await inHub(async ctx => {
      const lm = built(await ctx.llm.createModel(await provider('k'), providerInterface('responses'), model))
      const requests: unknown[] = []
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(await new Request(input, init).json())
        return Response.json(deepseekResponsesBody)
      })
      try {
        const prompts = ['file-first', 'file-second'].map(id => [{ role: 'user' as const, content: [{ type: 'file' as const, mediaType: 'application/pdf', data: { type: 'reference' as const, reference: { openai: id } } }] }])
        const before = JSON.stringify(prompts)
        const results = await Promise.all(prompts.map(prompt => lm.doGenerate({ prompt })))
        expect(requests).toEqual(expect.arrayContaining([
          expect.objectContaining({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_file', file_id: 'file-first' }] }] }),
          expect.objectContaining({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_file', file_id: 'file-second' }] }] }),
        ]))
        expect(results.map(result => result.content[0])).toEqual([expect.objectContaining({ type: 'reasoning', text: 'complete reasoning' }), expect.objectContaining({ type: 'reasoning', text: 'complete reasoning' })])
        expect(JSON.stringify(prompts)).toBe(before)
      } finally { vi.unstubAllGlobals() }
    })
  })

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
        const result = streamText({ model: lm, prompt: 'fixture', include: { rawChunks: true }, providerOptions: buildProviderOptions('responses', { reasoning_effort: 'high' }, { reasoning: true }) })
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

  it('replays streamed reasoning when completion metadata omits optional content', async () => {
    await inHub(async ctx => {
      const lm = await ctx.llm.createModel(await provider('k'), providerInterface('responses'), model)
      const requests: Array<{ input: unknown[] }> = []
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(await new Request(input as RequestInfo, init).json())
        return deepseekResponsesStream({ omitReasoningContent: true })
      })
      try {
        const acc = new PartAccumulator()
        for await (const part of streamText({ model: lm, prompt: 'fixture', include: { rawChunks: true } }).stream) {
          if (part.type === 'error') throw part.error
          acc.apply(part)
        }
        const persisted = JSON.parse(JSON.stringify(acc.parts[0])) as Part
        expect(persisted).toMatchObject({ type: 'reasoning', text: 'complete reasoning', providerOptions: { responses: {
          reasoningContent: deepseekReasoningItem.content, reasoningSummary: deepseekReasoningItem.summary, itemId: 'rs_fixture', reasoningEncryptedContent: 'fixture-encrypted-state',
        } } })
        const message: Message = { id: 1, conversation_id: 1, parent_id: null, seq: 1, role: 'assistant', parts: [persisted], provider_id: 1, model_id: model.model_id, usage: null, status: 'done', error: null, created_at: 0 }
        const beforeReplay = JSON.stringify(message)
        const messages = buildModelMessages({ protocol: 'responses', systemPrompt: null, path: [message], attachments: new Map() })
        for await (const part of streamText({ model: lm, messages }).stream) if (part.type === 'error') throw part.error
        expect(requests[1]!.input).toEqual([{
          type: 'reasoning', id: 'rs_fixture', summary: deepseekReasoningItem.summary,
          content: [{ type: 'reasoning_text', text: 'complete reasoning' }], encrypted_content: 'fixture-encrypted-state',
        }])
        expect(JSON.stringify(message)).toBe(beforeReplay)
      } finally { vi.unstubAllGlobals() }
    })
  })

  it.each([
    { text: 'fixture summary', summary: [{ type: 'summary_text', text: 'fixture summary' }], hasContentSentinel: true },
    { text: 'fixture summary', summary: [{ type: 'summary_text', text: 'fixture summary' }], hasContentSentinel: false },
    { text: '', summary: [], hasContentSentinel: true },
    { text: '', summary: [], hasContentSentinel: false },
  ])('keeps summary/encrypted-only Responses items free of invented full content (%j)', async ({ text, summary, hasContentSentinel }) => {
    await inHub(async ctx => {
      const lm = await ctx.llm.createModel(await provider('k'), providerInterface('responses'), model)
      let requestBody: unknown
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = await new Request(input as RequestInfo, init).json()
        return deepseekResponsesStream()
      })
      try {
        const part: Part = { type: 'reasoning', text, providerOptions: { responses: {
          itemId: 'rs_fixture', reasoningSummary: summary, ...(hasContentSentinel ? { reasoningContent: null } : {}), reasoningEncryptedContent: 'fixture-encrypted-state',
        } } }
        const message: Message = { id: 1, conversation_id: 1, parent_id: null, seq: 1, role: 'assistant', parts: [part], provider_id: 1, model_id: model.model_id, usage: null, status: 'done', error: null, created_at: 0 }
        const messages = buildModelMessages({ protocol: 'responses', systemPrompt: null, path: [message], attachments: new Map() })
        for await (const chunk of streamText({ model: lm, messages }).stream) if (chunk.type === 'error') throw chunk.error
        expect(requestBody).toMatchObject({ input: [{ type: 'reasoning', id: 'rs_fixture', summary, encrypted_content: 'fixture-encrypted-state' }] })
        expect((requestBody as { input: object[] }).input[0]).not.toHaveProperty('content')
      } finally { vi.unstubAllGlobals() }
    })
  })
})

describe('chat-completions files', () => {
  it.each(['generate', 'stream'] as const)('sends OpenAI file IDs through the actual %s SDK without changing other input content', async mode => {
    await inHub(async ctx => {
      const lm = built(await ctx.llm.createModel(await provider('k'), providerInterface('chat-completions'), model))
      let requestBody: unknown
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = await new Request(input, init).json()
        const message = { role: 'assistant', reasoning_content: 'file reasoning', content: 'file answer' }
        const response = { id: 'chat_fixture', object: mode === 'stream' ? 'chat.completion.chunk' : 'chat.completion', created: 1, model: 'test-model', choices: [{ index: 0, [mode === 'stream' ? 'delta' : 'message']: message, finish_reason: 'stop' }] }
        return mode === 'stream'
          ? new Response(`data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
          : Response.json(response)
      })
      try {
        const prompt = [{ role: 'user' as const, content: [
          { type: 'text' as const, text: 'read these' },
          { type: 'file' as const, mediaType: 'application/pdf', data: { type: 'reference' as const, reference: { openai: 'file-chat-document' } } },
          { type: 'file' as const, mediaType: 'image/png', data: { type: 'reference' as const, reference: { openai: 'file-chat-image' } } },
          { type: 'file' as const, mediaType: 'image/png', data: { type: 'url' as const, url: new URL('https://example.com/image.png?token=a%2Fb#keep') } },
          { type: 'file' as const, mediaType: 'application/pdf', filename: 'data.pdf', data: { type: 'data' as const, data: 'AQIDBA==' } },
        ] }]
        const before = JSON.stringify(prompt)
        if (mode === 'stream') {
          const result = await lm.doStream({ prompt })
          const chunks = []
          for await (const chunk of result.stream) chunks.push(chunk)
          expect(chunks).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'reasoning-delta', delta: 'file reasoning' })]))
        } else {
          const result = await lm.doGenerate({ prompt })
          expect(result.content).toContainEqual(expect.objectContaining({ type: 'reasoning', text: 'file reasoning' }))
        }
        expect(requestBody).toMatchObject({ messages: [{ role: 'user', content: [
          { type: 'text', text: 'read these' },
          { type: 'file', file: { file_id: 'file-chat-document' } },
          { type: 'file', file: { file_id: 'file-chat-image' } },
          { type: 'image_url', image_url: { url: 'https://example.com/image.png?token=a%2Fb#keep' } },
          { type: 'file', file: { filename: 'data.pdf', file_data: 'data:application/pdf;base64,AQIDBA==' } },
        ] }] })
        expect(JSON.stringify(prompt)).toBe(before)
      } finally { vi.unstubAllGlobals() }
    })
  })

  it('uses DeepSeek\'s flat file_id content part for native references', async () => {
    await inHub(async ctx => {
      const deepseek = { ...await provider('k'), models_dev_provider_id: 'deepseek' }
      const lm = built(await ctx.llm.createModel(deepseek, providerInterface('chat-completions'), model))
      let requestBody: unknown
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = await new Request(input, init).json()
        return Response.json({
          id: 'chat_fixture', object: 'chat.completion', created: 1, model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
        })
      })
      try {
        await lm.doGenerate({ prompt: [{ role: 'user', content: [{
          type: 'file', mediaType: 'image/png', data: { type: 'reference', reference: { openai: 'file-api-image' } },
        }] }] })
        expect(requestBody).toMatchObject({ messages: [{ role: 'user', content: [
          { type: 'file', file_id: 'file-api-image' },
        ] }] })
      } finally { vi.unstubAllGlobals() }
    })
  })
})

describe('chat-completions reasoning', () => {
  it.each([false, true])('replays the canonical full Responses body without concatenated summary deltas (completion content omitted: %s)', async omitReasoningContent => {
    await inHub(async ctx => {
      const responses = await ctx.llm.createModel(await provider('k'), providerInterface('responses'), model)
      const chat = await ctx.llm.createModel(await provider('k'), providerInterface('chat-completions'), model)
      let chatRequest: unknown
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input as RequestInfo, init)
        if (request.url.endsWith('/responses')) return deepseekResponsesStream({ omitReasoningContent })
        chatRequest = await request.json()
        const reply = { id: 'chat_fixture', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture answer' }, finish_reason: 'stop' }] }
        return new Response(`data: ${JSON.stringify(reply)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      })
      try {
        const acc = new PartAccumulator()
        for await (const part of streamText({ model: responses, prompt: 'fixture', include: { rawChunks: true } }).stream) {
          if (part.type === 'error') throw part.error
          acc.apply(part)
        }
        const persisted = JSON.parse(JSON.stringify(acc.parts[0])) as Part
        const message: Message = { id: 1, conversation_id: 1, parent_id: null, seq: 1, role: 'assistant', parts: [persisted], provider_id: 1, model_id: model.model_id, usage: null, status: 'done', error: null, created_at: 0 }
        const messages = buildModelMessages({ protocol: 'chat-completions', systemPrompt: null, path: [message], attachments: new Map() })
        for await (const part of streamText({ model: chat, messages }).stream) if (part.type === 'error') throw part.error
        expect(chatRequest).toMatchObject({ messages: [{ role: 'assistant', reasoning_content: 'complete reasoning' }] })
      } finally { vi.unstubAllGlobals() }
    })
  })

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
        // toMatchObject, not toEqual: a closed reasoning block also carries its duration, and what
        // this case is about is the text surviving into the replay below.
        expect(persisted).toMatchObject([{ type: 'reasoning', text: 'complete reasoning' }, { type: 'text', text: 'fixture answer' }])
        const message: Message = { id: 1, conversation_id: 1, parent_id: null, seq: 1, role: 'assistant', parts: persisted, provider_id: 1, model_id: model.model_id, usage: null, status: 'done', error: null, created_at: 0 }
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
