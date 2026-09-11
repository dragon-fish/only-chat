import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import type { Context } from 'cordis'
import type { FilesV4, FilesV4UploadFileCallOptions } from '@ai-sdk/provider'
import { createOpenResponses } from '@ai-sdk/open-responses'
import { DefaultGeneratedFile, type GeneratedFile } from 'ai'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '@/server/app'
import { createDb, type DB } from '@/server/db/client'
import { ensureTestUser as seedTestUser } from './auth-helper'
import type { Assets } from '@/server/plugins/assets'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import { buildModelMessages } from '@/server/plugins/llm/messages'
import { MAX_UPLOAD_BYTES, r2Key } from '@/server/plugins/api/attachments'
import type { Hub } from '@/server/plugins/hub'
import { persistGeneratedImage } from '@/server/plugins/hub/generated-images'
import { resolveEffectiveConfig } from '@/server/plugins/hub/effective-config'
import { getProject } from '@/server/plugins/hub/projects'
import {
  appendToolResult, createConversation, deleteMessageIfUnreferenced, finalizeMessage, getMessage, getConversation, insertMessage,
  listMessages, replaceMessagePartsIfCurrentHead, toMessage, updateConversation,
} from '@/server/plugins/hub/conversations'
import { attachmentProviderFiles, attachments, models, projects, providerInterfaces, providers, users } from '@/server/db/schema'
import type { ProviderInterfaceRow, ProviderRow } from '@/server/db/schema'
import { sendCommandFor } from '@/client/stores/sync'
import type { Message, ConversationParams } from '@/shared/models'
import type { ModelMetadata } from '@/shared/model-metadata'
import type { Part } from '@/shared/parts'
import type { UserHub } from '@/server/index'
import { connect, type WsHarness } from './ws-helper'
import { deepseekReasoningItem, deepseekResponsesStream } from '../fixtures/deepseek-responses-stream'

/** The provider-level chunk type, taken from the mock itself so no extra dependency is needed. */
type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never

const STREAM: StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', id: 'r', modelId: 'mock', timestamp: new Date(0) },
  { type: 'reasoning-start', id: 'r1' },
  { type: 'reasoning-delta', id: 'r1', delta: 'think' },
  { type: 'reasoning-end', id: 'r1', providerMetadata: { anthropic: { signature: 'SIG' } } },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'Hello, ' },
  { type: 'text-delta', id: 't1', delta: 'world!' },
  { type: 'text-end', id: 't1' },
  {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 10, noCache: 8, cacheRead: 2, cacheWrite: 0 },
      outputTokens: { total: 5, text: 3, reasoning: 2 },
      raw: {},
    },
  },
]

const ASK_USER_INPUT = {
  questions: [{
    id: 'framework', header: '框架', question: '选择框架', type: 'single' as const,
    options: [{ label: 'Vue' }, { label: 'React' }], allowOther: false,
  }],
}

const TOOL_STREAM: StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', id: 'tool-response', modelId: 'mock', timestamp: new Date(0) },
  { type: 'tool-call', toolCallId: 'call-ask-1', toolName: 'ask_user', input: ASK_USER_INPUT },
  {
    type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 }, raw: {},
    },
  },
] as StreamPart[]

const MULTI_TOOL_STREAM: StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', id: 'multi-tool-response', modelId: 'mock', timestamp: new Date(0) },
  { type: 'tool-call', toolCallId: 'call-ask-1', toolName: 'ask_user', input: ASK_USER_INPUT },
  { type: 'tool-call', toolCallId: 'call-ask-2', toolName: 'ask_user', input: {
    questions: [{ id: 'detail', header: '补充', question: '补充说明', type: 'text' }],
  } },
  {
    type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 }, raw: {},
    },
  },
] as StreamPart[]

async function seedProvider(name = 'mock', modelId = 'mock-1', nativeFiles = false, metadata: ModelMetadata = { reasoning: true }): Promise<number> {
  const db = createDb(env.DB)
  await seedTestUser(db)
  const [p] = await db.insert(providers).values({
    user_id: 1, name,
    api_key: await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'k'), enabled: true, created_at: 0,
  }).returning()
  const [selected] = await db.insert(providerInterfaces).values({ provider_id: p!.id, protocol: 'responses', base_url: 'https://mock.example/responses-api', native_files: nativeFiles, created_at: 0 }).returning()
  await db.update(providers).set({ default_interface_id: selected!.id }).where(eq(providers.id, p!.id))
  await db.insert(models).values({ provider_id: p!.id, model_id: modelId, metadata_resolved: metadata, enabled: true, sort: 0 })
  return p!.id
}

const toBase64 = (bytes: Uint8Array<ArrayBuffer>) => btoa(String.fromCharCode(...bytes))

const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')

const attachmentBySha = (digest: string) =>
  createDb(env.DB).query.attachments.findFirst({ where: eq(attachments.sha256, digest) })

/**
 * Distinct bytes on every call. D1 is shared across this project's tests and attachments dedupe by
 * SHA-256, so reusing one image would let an unrelated test decide whether a row is new.
 */
let imageSeq = 0
function uniqueImageBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...new TextEncoder().encode(`generated-${++imageSeq}`)])
}

async function seedProject(input: Partial<typeof projects.$inferInsert> = {}): Promise<number> {
  const db = createDb(env.DB)
  const [row] = await db.insert(projects).values({
    user_id: 1, name: 'P', system_prompt: null, provider_id: null, model_id: null,
    params: null, created_at: 0, updated_at: 0, ...input,
  }).returning()
  return row!.id
}

/** Whatever the DO would replay to a client that reconnects mid-generation. */
async function inflightSnapshot(): Promise<string> {
  const stub = env.USER_HUB.getByName(String(1))
  return runInDurableObject(stub, async (_instance: UserHub, state) => {
    const stored = await state.storage.list({ prefix: 'inflight:' })
    return JSON.stringify([...stored.values()])
  })
}

async function nextImagePart(c: WsHarness) {
  for (let count = 1; ; count++) {
    const event = await c.nextAfter('message.part', count)
    if (event.type === 'message.part' && event.part.type === 'image') return { ...event, part: event.part }
  }
}

/** Every file part the adapter actually received, across all roles of one call's prompt. */
function filePartsOf(model: MockLanguageModelV4): Array<{ type: string; mediaType: string; data: unknown }> {
  const parts = model.doStreamCalls[0]!.prompt.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string }>) : []))
  return parts.filter((p) => p.type === 'file') as Array<{ type: string; mediaType: string; data: unknown }>
}

const pointersOf = (attachmentId: number) =>
  createDb(env.DB).select().from(attachmentProviderFiles).where(eq(attachmentProviderFiles.attachment_id, attachmentId))

const conversationIdOf = (c: WsHarness) => (c.events.find((e) => e.type === 'conversation.created') as { conversation: { id: number } }).conversation.id

interface Upload { providerId: number; options: FilesV4UploadFileCallOptions }

/**
 * A FilesV4 that hands out a distinct id per provider and per upload, so "which provider uploaded,
 * and how many times" is readable straight off the recorded list.
 */
function recordingFiles(uploads: Upload[], expiresAt?: Date) {
  const counters = new Map<number, number>()
  return (provider: ProviderRow): FilesV4 => ({
    specificationVersion: 'v4',
    provider: 'mock',
    async uploadFile(options) {
      uploads.push({ providerId: provider.id, options })
      const n = (counters.get(provider.id) ?? 0) + 1
      counters.set(provider.id, n)
      return { warnings: [], providerReference: { mock: `file-${provider.id}-${n}` }, ...(expiresAt ? { expiresAt } : {}) }
    },
  })
}

async function installMock(
  mockFactory: () => MockLanguageModelV4,
  createFiles?: (provider: ProviderRow, providerInterface: ProviderInterfaceRow, apiKey: string) => FilesV4,
  protocols = ['responses'],
): Promise<MockLanguageModelV4[]> {
  const created: MockLanguageModelV4[] = []
  await connect(await seedTestUser())
  const stub = env.USER_HUB.getByName(String(1))
  await runInDurableObject(stub, async (instance: UserHub) => {
    await instance.app.plugin({
      name: 'mock-protocol',
      inject: ['llm'],
      apply(c) {
        for (const protocol of protocols) c.llm.register(protocol, {
          createModel: () => { const m = mockFactory(); created.push(m); return m as never },
          ...(createFiles ? { createFiles: (provider: ProviderRow, selected: ProviderInterfaceRow, apiKey: string) => ({
            family: protocol === 'anthropic' ? 'anthropic' as const : 'openai' as const, baseURL: selected.base_url.replace(/\/+$/, ''), credentialVersion: provider.credential_version,
            files: createFiles(provider, selected, apiKey),
          }) } : {}),
        })
      },
    })
  })
  return created
}

/**
 * Drops the wall-clock duration a closed reasoning block carries. These cases are about what the
 * stream persisted and replayed; a timing number in their expectations would only obscure that.
 */
function untimed(value: unknown): any {
  if (Array.isArray(value)) return value.map(untimed)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'duration_ms').map(([key, entry]) => [key, untimed(entry)]),
  )
}

describe('generation', () => {
  it('passes globally enabled conversation tools to the model and persists an unresolved call without executing it', async () => {
    const providerId = await seedProvider('tool-provider', 'tool-model', false, { tool_call: true })
    const db = createDb(env.DB)
    await db.update(users).set({ settings: { plugins: { ask_user: true } } }).where(eq(users.id, 1))
    const created = await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: TOOL_STREAM, chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'ask me' }],
      provider_id: providerId, model_id: 'tool-model', tools: ['ask_user'],
    }))
    await c.next('message.done')

    const rows = await listMessages(db, conversationIdOf(c), 1)
    expect(untimed(rows[1]!.parts)).toEqual([{ type: 'tool_call', id: 'call-ask-1', name: 'ask_user', args: ASK_USER_INPUT }])
    expect(rows[1]!.parts.some(part => part.type === 'tool_result')).toBe(false)
    expect(created).toHaveLength(1)
    expect(created[0]!.doStreamCalls[0]!.tools?.map(tool => tool.name)).toEqual(['ask_user'])
  })

  it('repairs invalid ask_user arguments before persisting the completed call', async () => {
    const providerId = await seedProvider('invalid-tool-provider', 'invalid-tool-model', false, { tool_call: true })
    const db = createDb(env.DB)
    await db.update(users).set({ settings: { plugins: { ask_user: true } } }).where(eq(users.id, 1))
    const invalidStream: StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: 'bad-call', toolName: 'ask_user', input: JSON.stringify({ questions: [] }) },
      {
        type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 }, raw: {},
        },
      },
    ] as StreamPart[]
    const created = await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: invalidStream, chunkDelayInMs: null, initialDelayInMs: null }) }),
      doGenerate: {
        content: [{ type: 'text', text: JSON.stringify(ASK_USER_INPUT) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 }, raw: {},
        },
        warnings: [],
      },
    }))
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'bad ask' }],
      provider_id: providerId, model_id: 'invalid-tool-model', tools: ['ask_user'],
    }))
    expect(await c.next('message.done')).toMatchObject({ status: 'done', error: null })
    expect((await listMessages(db, conversationIdOf(c), 1))[1]).toMatchObject({
      status: 'done', error: null,
      parts: [{ type: 'tool_call', id: 'bad-call', name: 'ask_user', args: ASK_USER_INPUT }],
    })
    expect(created[0]!.doGenerateCalls).toHaveLength(1)
    expect(created[0]!.doGenerateCalls[0]!.tools).toBeUndefined()
  })

  it('rejects enabled selected tools before generation when the model lacks tool-call support', async () => {
    const providerId = await seedProvider('no-tools-provider', 'no-tools-model', false, {})
    const db = createDb(env.DB)
    await db.update(users).set({ settings: { plugins: { ask_user: true } } }).where(eq(users.id, 1))
    const created = await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: STREAM, chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', request_id: 'no-tools', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
      provider_id: providerId, model_id: 'no-tools-model', tools: ['ask_user'],
    }))
    expect(await c.next('error')).toMatchObject({ request_id: 'no-tools', message: expect.stringMatching(/工具/) })
    expect(created).toHaveLength(0)
  })

  it('suppresses globally disabled selected tools without deleting or blocking the conversation snapshot', async () => {
    const providerId = await seedProvider('disabled-tool-provider', 'disabled-tool-model', false, {})
    const db = createDb(env.DB)
    await db.update(users).set({ settings: { plugins: { ask_user: false } } }).where(eq(users.id, 1))
    const created = await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: STREAM, chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
      provider_id: providerId, model_id: 'disabled-tool-model', tools: ['ask_user'],
    }))
    await c.next('message.done')
    expect((await getConversation(db, conversationIdOf(c), 1))!.tools).toEqual(['ask_user'])
    expect(created[0]!.doStreamCalls[0]!.tools).toBeUndefined()
  })

  it('atomically stores an ask_user answer and continues from the tool-call message', async () => {
    const providerId = await seedProvider('answer-provider', 'answer-model', false, { tool_call: true })
    const db = createDb(env.DB)
    await db.update(users).set({ settings: { plugins: { ask_user: true } } }).where(eq(users.id, 1))
    const streams = [TOOL_STREAM, STREAM]
    const created = await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: streams.shift()!, chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'ask me' }],
      provider_id: providerId, model_id: 'answer-model', tools: ['ask_user'],
    }))
    await c.next('message.done')
    const conversationId = conversationIdOf(c)
    const firstAssistant = (await listMessages(db, conversationId, 1))[1]!
    // Pending historical calls remain answerable after global disablement; only the next request's
    // actual tool set is filtered.
    await db.update(users).set({ settings: { plugins: { ask_user: false } } }).where(eq(users.id, 1))
    c.events.length = 0
    c.ws.send(JSON.stringify({
      type: 'tool.respond', request_id: 'answer-1', message_id: firstAssistant.id, call_id: 'call-ask-1',
      result: { status: 'answered', answers: [{ id: 'framework', value: 'Vue' }] },
    }))

    expect(await c.next('message.part')).toMatchObject({
      message_id: firstAssistant.id,
      part: { type: 'tool_result', call_id: 'call-ask-1', name: 'ask_user', content: { status: 'answered' } },
    })
    await c.next('message.done')
    const rows = await listMessages(db, conversationId, 1)
    expect(rows.map(row => [row.role, row.parent_id])).toEqual([
      ['user', null], ['assistant', rows[0]!.id], ['assistant', firstAssistant.id],
    ])
    expect(rows[1]!.parts.at(-1)).toEqual({
      type: 'tool_result', call_id: 'call-ask-1', name: 'ask_user',
      content: { status: 'answered', answers: [{ id: 'framework', value: 'Vue' }] },
    })
    expect(created).toHaveLength(2)
    expect(created[1]!.doStreamCalls[0]!.prompt.map(message => message.role)).toEqual(['user', 'assistant', 'tool'])
    expect(created[1]!.doStreamCalls[0]!.tools).toBeUndefined()

  })

  it('persists cancellation without starting another generation', async () => {
    const providerId = await seedProvider('cancel-provider', 'cancel-model', false, { tool_call: true })
    const db = createDb(env.DB)
    await db.update(users).set({ settings: { plugins: { ask_user: true } } }).where(eq(users.id, 1))
    const created = await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: TOOL_STREAM, chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'ask me' }],
      provider_id: providerId, model_id: 'cancel-model', tools: ['ask_user'],
    }))
    await c.next('message.done')
    const conversationId = conversationIdOf(c)
    const firstAssistant = (await listMessages(db, conversationId, 1))[1]!
    c.events.length = 0
    c.ws.send(JSON.stringify({
      type: 'tool.respond', request_id: 'cancel-1', message_id: firstAssistant.id, call_id: 'call-ask-1',
      result: { status: 'cancelled', message: '用户选择了取消回答' },
    }))
    await c.next('message.part')
    const rows = await listMessages(db, conversationId, 1)
    expect(rows).toHaveLength(2)
    expect(rows[1]!.parts.at(-1)).toMatchObject({ type: 'tool_result', content: { status: 'cancelled' } })
    expect(created).toHaveLength(1)
  })

  it('continues generation when every optional question is explicitly skipped', async () => {
    const providerId = await seedProvider('skip-all-provider', 'skip-all-model', false, { tool_call: true })
    const db = createDb(env.DB)
    await db.update(users).set({ settings: { plugins: { ask_user: true } } }).where(eq(users.id, 1))
    const streams = [TOOL_STREAM, STREAM]
    const created = await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: streams.shift()!, chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'ask me' }],
      provider_id: providerId, model_id: 'skip-all-model', tools: ['ask_user'],
    }))
    await c.next('message.done')
    const assistant = (await listMessages(db, conversationIdOf(c), 1))[1]!
    c.events.length = 0
    c.ws.send(JSON.stringify({
      type: 'tool.respond', request_id: 'skip-all', message_id: assistant.id, call_id: 'call-ask-1',
      result: { status: 'answered', answers: [{ id: 'framework', value: null }] },
    }))

    expect(await c.next('message.part')).toMatchObject({
      part: { type: 'tool_result', content: { status: 'answered', answers: [{ id: 'framework', value: null }] } },
    })
    await c.next('message.done')
    expect(created).toHaveLength(2)
  })

  it('accepts identical response retries but rejects a conflicting second result', async () => {
    const providerId = await seedProvider('retry-provider', 'retry-model', false, { tool_call: true })
    const db = createDb(env.DB)
    await db.update(users).set({ settings: { plugins: { ask_user: true } } }).where(eq(users.id, 1))
    await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: TOOL_STREAM, chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'ask me' }],
      provider_id: providerId, model_id: 'retry-model', tools: ['ask_user'],
    }))
    await c.next('message.done')
    const conversationId = conversationIdOf(c)
    const assistant = (await listMessages(db, conversationId, 1))[1]!
    const cancelled = { status: 'cancelled', message: '用户选择了取消回答' }
    c.events.length = 0
    c.ws.send(JSON.stringify({ type: 'tool.respond', request_id: 'r1', message_id: assistant.id, call_id: 'call-ask-1', result: cancelled }))
    await c.next('message.part')
    c.events.length = 0
    c.ws.send(JSON.stringify({ type: 'tool.respond', request_id: 'r2', message_id: assistant.id, call_id: 'call-ask-1', result: cancelled }))
    c.ws.send(JSON.stringify({
      type: 'tool.respond', request_id: 'r3', message_id: assistant.id, call_id: 'call-ask-1',
      result: { status: 'answered', answers: [{ id: 'framework', value: 'Vue' }] },
    }))
    expect(await c.next('error')).toMatchObject({ request_id: 'r3', message: expect.stringMatching(/conflict/i) })
    const stored = (await listMessages(db, conversationId, 1))[1]!
    expect(stored.parts.filter(part => part.type === 'tool_result')).toHaveLength(1)
  })

  it('rejects unknown calls and answer values with the wrong shape for the persisted question', async () => {
    const providerId = await seedProvider('invalid-answer-provider', 'invalid-answer-model', false, { tool_call: true })
    const db = createDb(env.DB)
    await db.update(users).set({ settings: { plugins: { ask_user: true } } }).where(eq(users.id, 1))
    await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: TOOL_STREAM, chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'ask me' }],
      provider_id: providerId, model_id: 'invalid-answer-model', tools: ['ask_user'],
    }))
    await c.next('message.done')
    const conversationId = conversationIdOf(c)
    const assistant = (await listMessages(db, conversationId, 1))[1]!
    c.events.length = 0
    c.ws.send(JSON.stringify({
      type: 'tool.respond', request_id: 'unknown-call', message_id: assistant.id, call_id: 'missing',
      result: { status: 'cancelled', message: '用户选择了取消回答' },
    }))
    expect(await c.nextAfter('error', 1)).toMatchObject({ request_id: 'unknown-call' })
    c.ws.send(JSON.stringify({
      type: 'tool.respond', request_id: 'bad-shape', message_id: assistant.id, call_id: 'call-ask-1',
      result: { status: 'answered', answers: [{ id: 'framework', value: ['Svelte'] }] },
    }))
    expect(await c.nextAfter('error', 2)).toMatchObject({ request_id: 'bad-shape' })
    expect((await listMessages(db, conversationId, 1))[1]!.parts.filter(part => part.type === 'tool_result')).toEqual([])
  })

  it('rejects a tool response for another user conversation without mutating it', async () => {
    const db = createDb(env.DB)
    await seedTestUser(db)
    const [other] = await db.insert(users).values({ name: 'tool-owner', settings: { plugins: {} }, createdAt: new Date(0), updatedAt: new Date(0), email: crypto.randomUUID() + '@example.com' }).returning()
    const conversation = await createConversation(db, {
      user_id: other!.id, title: 'private', provider_id: null, model_id: null,
    })
    const message = await insertMessage(db, other!.id, {
      conversation_id: conversation.id, parent_id: null, seq: 1, role: 'assistant', status: 'done', error: null,
      provider_id: null, model_id: null, usage: null, created_at: 0,
      parts: [{ type: 'tool_call', id: 'private-call', name: 'ask_user', args: ASK_USER_INPUT }],
    })
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'tool.respond', request_id: 'foreign', message_id: message.id, call_id: 'private-call',
      result: { status: 'cancelled', message: '用户选择了取消回答' },
    }))
    expect(await c.next('error')).toMatchObject({ request_id: 'foreign', message: 'tool-call message not found' })
    expect((await getMessage(db, message.id, other!.id))!.parts).toHaveLength(1)
  })

  it('waits for every tool call before continuing', async () => {
    const providerId = await seedProvider('multi-answer-provider', 'multi-answer-model', false, { tool_call: true })
    const db = createDb(env.DB)
    await db.update(users).set({ settings: { plugins: { ask_user: true } } }).where(eq(users.id, 1))
    const streams = [MULTI_TOOL_STREAM, STREAM]
    const created = await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: streams.shift()!, chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'ask twice' }],
      provider_id: providerId, model_id: 'multi-answer-model', tools: ['ask_user'],
    }))
    await c.next('message.done')
    const conversationId = conversationIdOf(c)
    const assistant = (await listMessages(db, conversationId, 1))[1]!

    await runInDurableObject(env.USER_HUB.getByName(String(1)), async (instance: UserHub) => {
      await instance.app.hub.handleCommand(instance.app.hub.state.getWebSockets()[0]!, JSON.stringify({
        type: 'tool.respond', request_id: 'first', message_id: assistant.id, call_id: 'call-ask-1',
        result: { status: 'answered', answers: [{ id: 'framework', value: 'Vue' }] },
      }))
    })
    expect(created).toHaveLength(1)
    expect(await listMessages(db, conversationId, 1)).toHaveLength(2)

    c.events.length = 0
    c.ws.send(JSON.stringify({
      type: 'tool.respond', request_id: 'second', message_id: assistant.id, call_id: 'call-ask-2',
      result: { status: 'answered', answers: [{ id: 'detail', value: 'ship it' }] },
    }))
    await c.next('message.done')
    expect(created).toHaveLength(2)
    expect(await listMessages(db, conversationId, 1)).toHaveLength(3)
  })

  it('recovers continuation when an identical answered retry follows a stored result without a child shell', async () => {
    const providerId = await seedProvider('recover-provider', 'recover-model', false, { tool_call: true })
    const db = createDb(env.DB)
    await db.update(users).set({ settings: { plugins: { ask_user: true } } }).where(eq(users.id, 1))
    const streams = [TOOL_STREAM, STREAM]
    const created = await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: streams.shift()!, chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'ask me' }],
      provider_id: providerId, model_id: 'recover-model', tools: ['ask_user'],
    }))
    await c.next('message.done')
    const conversationId = conversationIdOf(c)
    const assistant = (await listMessages(db, conversationId, 1))[1]!
    expect(await appendToolResult(db, assistant.id, 1, conversationId, {
      type: 'tool_result', call_id: 'call-ask-1', name: 'ask_user',
      content: { status: 'answered', answers: [{ id: 'framework', value: 'Vue' }] },
    })).toBe(true)

    await runInDurableObject(env.USER_HUB.getByName(String(1)), async (instance: UserHub) => {
      await instance.app.hub.handleCommand(instance.app.hub.state.getWebSockets()[0]!, JSON.stringify({
        type: 'tool.respond', request_id: 'recover', message_id: assistant.id, call_id: 'call-ask-1',
        result: { status: 'answered', answers: [{ id: 'framework', value: 'Vue' }] },
      }))
    })
    expect(created).toHaveLength(2)
    const rows = await listMessages(db, conversationId, 1)
    expect(rows).toHaveLength(3)
    expect(rows[2]!.parent_id).toBe(assistant.id)
  })

  it('repairs the Conversation head when a continuation child exists but the head update was interrupted', async () => {
    const db = createDb(env.DB)
    await seedTestUser(db)
    const conversation = await createConversation(db, {
      user_id: 1, title: 'repair head', provider_id: null, model_id: null,
    })
    const toolMessage = await insertMessage(db, 1, {
      conversation_id: conversation.id, parent_id: null, seq: 1, role: 'assistant', status: 'done', error: null,
      provider_id: null, model_id: null, usage: null, created_at: 0,
      parts: [
        { type: 'tool_call', id: 'repair-call', name: 'ask_user', args: ASK_USER_INPUT },
        {
          type: 'tool_result', call_id: 'repair-call', name: 'ask_user',
          content: { status: 'answered', answers: [{ id: 'framework', value: 'Vue' }] },
        },
      ],
    })
    const child = await insertMessage(db, 1, {
      conversation_id: conversation.id, parent_id: toolMessage.id, seq: 2, role: 'assistant', status: 'done', error: null,
      provider_id: null, model_id: null, usage: null, created_at: 1, parts: [{ type: 'text', text: 'continued' }],
    })
    await updateConversation(db, conversation.id, 1, { head_message_id: toolMessage.id })
    const c = await connect(await seedTestUser())
    c.events.length = 0

    await runInDurableObject(env.USER_HUB.getByName(String(1)), async (instance: UserHub) => {
      await instance.app.hub.handleCommand(instance.app.hub.state.getWebSockets()[0]!, JSON.stringify({
        type: 'tool.continue', request_id: 'repair-head', message_id: toolMessage.id,
      }))
    })

    expect((await getConversation(db, conversation.id, 1))!.head_message_id).toBe(child.id)
    expect(await c.next('head.changed')).toMatchObject({ conversation_id: conversation.id, message_id: child.id })
  })

  it('does not rewind a newer Conversation head on an identical response retry for an old tool call', async () => {
    const db = createDb(env.DB)
    await seedTestUser(db)
    const conversation = await createConversation(db, {
      user_id: 1, title: 'keep newer head', provider_id: null, model_id: null,
    })
    const toolMessage = await insertMessage(db, 1, {
      conversation_id: conversation.id, parent_id: null, seq: 1, role: 'assistant', status: 'done', error: null,
      provider_id: null, model_id: null, usage: null, created_at: 0,
      parts: [
        { type: 'tool_call', id: 'old-call', name: 'ask_user', args: ASK_USER_INPUT },
        {
          type: 'tool_result', call_id: 'old-call', name: 'ask_user',
          content: { status: 'answered', answers: [{ id: 'framework', value: 'Vue' }] },
        },
      ],
    })
    const child = await insertMessage(db, 1, {
      conversation_id: conversation.id, parent_id: toolMessage.id, seq: 2, role: 'assistant', status: 'done', error: null,
      provider_id: null, model_id: null, usage: null, created_at: 1, parts: [{ type: 'text', text: 'continued' }],
    })
    const newer = await insertMessage(db, 1, {
      conversation_id: conversation.id, parent_id: child.id, seq: 3, role: 'user', status: 'done', error: null,
      provider_id: null, model_id: null, usage: null, created_at: 2, parts: [{ type: 'text', text: 'later' }],
    })
    await updateConversation(db, conversation.id, 1, { head_message_id: newer.id })
    const c = await connect(await seedTestUser())
    c.events.length = 0

    await runInDurableObject(env.USER_HUB.getByName(String(1)), async (instance: UserHub) => {
      await instance.app.hub.handleCommand(instance.app.hub.state.getWebSockets()[0]!, JSON.stringify({
        type: 'tool.respond', request_id: 'old-retry', message_id: toolMessage.id, call_id: 'old-call',
        result: { status: 'answered', answers: [{ id: 'framework', value: 'Vue' }] },
      }))
    })

    expect((await getConversation(db, conversation.id, 1))!.head_message_id).toBe(newer.id)
    expect(c.events.some(event => event.type === 'head.changed')).toBe(false)
    expect(c.events.some(event => event.type === 'error')).toBe(false)
    expect(c.events.some(event => event.type === 'conversation.updated')).toBe(false)
  })

  it('stores a delayed answer on an old branch without creating a continuation or rewinding the head', async () => {
    const db = createDb(env.DB)
    await seedTestUser(db)
    const conversation = await createConversation(db, {
      user_id: 1, title: 'delayed answer', provider_id: null, model_id: null,
    })
    const toolMessage = await insertMessage(db, 1, {
      conversation_id: conversation.id, parent_id: null, seq: 1, role: 'assistant', status: 'done', error: null,
      provider_id: null, model_id: null, usage: null, created_at: 0,
      parts: [{ type: 'tool_call', id: 'delayed-call', name: 'ask_user', args: ASK_USER_INPUT }],
    })
    const newer = await insertMessage(db, 1, {
      conversation_id: conversation.id, parent_id: toolMessage.id, seq: 2, role: 'user', status: 'done', error: null,
      provider_id: null, model_id: null, usage: null, created_at: 1, parts: [{ type: 'text', text: 'moved on' }],
    })
    await updateConversation(db, conversation.id, 1, { head_message_id: newer.id })
    const c = await connect(await seedTestUser())
    c.events.length = 0

    await runInDurableObject(env.USER_HUB.getByName(String(1)), async (instance: UserHub) => {
      await instance.app.hub.handleCommand(instance.app.hub.state.getWebSockets()[0]!, JSON.stringify({
        type: 'tool.respond', request_id: 'delayed', message_id: toolMessage.id, call_id: 'delayed-call',
        result: { status: 'answered', answers: [{ id: 'framework', value: 'Vue' }] },
      }))
    })

    expect((await getMessage(db, toolMessage.id, 1))!.parts.at(-1)).toMatchObject({
      type: 'tool_result', call_id: 'delayed-call', content: { status: 'answered' },
    })
    expect(await listMessages(db, conversation.id, 1)).toHaveLength(2)
    expect((await getConversation(db, conversation.id, 1))!.head_message_id).toBe(newer.id)
    expect(c.events.some(event => event.type === 'head.changed')).toBe(false)
    expect(c.events.some(event => event.type === 'error')).toBe(false)
  })

  it('atomically cancels a pending ask_user call before continuing an ordinary stale-client send', async () => {
    const providerId = await seedProvider('stale-send-provider', 'stale-send-model', false, { tool_call: true })
    const db = createDb(env.DB)
    const conversation = await createConversation(db, {
      user_id: 1, title: 'waiting', provider_id: providerId, model_id: 'stale-send-model',
    })
    const waiting = await insertMessage(db, 1, {
      conversation_id: conversation.id, parent_id: null, seq: 1, role: 'assistant', status: 'done', error: null,
      provider_id: providerId, model_id: 'stale-send-model', usage: null, created_at: 0,
      parts: [{ type: 'tool_call', id: 'still-waiting', name: 'ask_user', args: ASK_USER_INPUT }],
    })
    await updateConversation(db, conversation.id, 1, { head_message_id: waiting.id })
    const created = await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: STREAM, chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', request_id: 'stale-send', conversation_id: conversation.id, parent_id: waiting.id,
      parts: [{ type: 'text', text: 'bypass pending tool' }], provider_id: providerId, model_id: 'stale-send-model',
    }))

    expect(await c.next('message.part')).toMatchObject({
      message_id: waiting.id,
      part: {
        type: 'tool_result', call_id: 'still-waiting', name: 'ask_user',
        content: { status: 'cancelled', message: '用户跳过了问题并继续回复' },
      },
    })
    expect(await c.next('message.done')).toMatchObject({ status: 'done' })
    expect(await listMessages(db, conversation.id, 1)).toHaveLength(3)
    expect(created).toHaveLength(1)
  })

  it('cancels every pending ask_user call in one parent before persisting the user reply', async () => {
    const providerId = await seedProvider('multi-skip-provider', 'multi-skip-model', false, { tool_call: true })
    const db = createDb(env.DB)
    const conversation = await createConversation(db, {
      user_id: 1, title: 'multi waiting', provider_id: providerId, model_id: 'multi-skip-model',
    })
    const waiting = await insertMessage(db, 1, {
      conversation_id: conversation.id, parent_id: null, seq: 1, role: 'assistant', status: 'done', error: null,
      provider_id: providerId, model_id: 'multi-skip-model', usage: null, created_at: 0,
      parts: [
        { type: 'tool_call', id: 'skip-one', name: 'ask_user', args: ASK_USER_INPUT },
        {
          type: 'tool_call', id: 'skip-two', name: 'ask_user',
          args: { questions: [{ id: 'detail', header: '补充', question: '补充说明', type: 'text' }] },
        },
      ],
    })
    await updateConversation(db, conversation.id, 1, { head_message_id: waiting.id })
    await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: STREAM, chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: conversation.id, parent_id: waiting.id,
      parts: [{ type: 'text', text: 'skip both' }], provider_id: providerId, model_id: 'multi-skip-model',
    }))
    const first = await c.nextAfter('message.part', 1)
    const second = await c.nextAfter('message.part', 2)
    expect([first, second].map(event => event.type === 'message.part' && event.part.type === 'tool_result' ? event.part.call_id : null))
      .toEqual(['skip-one', 'skip-two'])
    await c.next('message.done')
    const stored = (await getMessage(db, waiting.id, 1))!
    expect(stored.parts.filter(part => part.type === 'tool_result')).toHaveLength(2)
  })

  it('answer-wins CAS leaves the answered result intact and rejects the stale skip snapshot', async () => {
    const db = createDb(env.DB)
    await seedTestUser(db)
    const conversation = await createConversation(db, { user_id: 1, title: 'answer wins', provider_id: null, model_id: null })
    const waiting = await insertMessage(db, 1, {
      conversation_id: conversation.id, parent_id: null, seq: 1, role: 'assistant', status: 'done', error: null,
      provider_id: null, model_id: null, usage: null, created_at: 0,
      parts: [{ type: 'tool_call', id: 'race-call', name: 'ask_user', args: ASK_USER_INPUT }],
    })
    await updateConversation(db, conversation.id, 1, { head_message_id: waiting.id })
    const skipped = [...waiting.parts, {
      type: 'tool_result' as const, call_id: 'race-call', name: 'ask_user',
      content: { status: 'cancelled', message: '用户跳过了问题并继续回复' },
    }]
    expect(await appendToolResult(db, waiting.id, 1, conversation.id, {
      type: 'tool_result', call_id: 'race-call', name: 'ask_user',
      content: { status: 'answered', answers: [{ id: 'framework', value: 'Vue' }] },
    })).toBe(true)
    expect(await replaceMessagePartsIfCurrentHead(db, waiting, 1, skipped)).toBe(false)
    expect((await getMessage(db, waiting.id, 1))!.parts.at(-1)).toMatchObject({ content: { status: 'answered' } })
  })

  it('skip-wins CAS makes a late tool response lose the existing call-id fence', async () => {
    const db = createDb(env.DB)
    await seedTestUser(db)
    const conversation = await createConversation(db, { user_id: 1, title: 'skip wins', provider_id: null, model_id: null })
    const waiting = await insertMessage(db, 1, {
      conversation_id: conversation.id, parent_id: null, seq: 1, role: 'assistant', status: 'done', error: null,
      provider_id: null, model_id: null, usage: null, created_at: 0,
      parts: [{ type: 'tool_call', id: 'race-call', name: 'ask_user', args: ASK_USER_INPUT }],
    })
    await updateConversation(db, conversation.id, 1, { head_message_id: waiting.id })
    const skipped = [...waiting.parts, {
      type: 'tool_result' as const, call_id: 'race-call', name: 'ask_user',
      content: { status: 'cancelled', message: '用户跳过了问题并继续回复' },
    }]
    expect(await replaceMessagePartsIfCurrentHead(db, waiting, 1, skipped)).toBe(true)
    expect(await appendToolResult(db, waiting.id, 1, conversation.id, {
      type: 'tool_result', call_id: 'race-call', name: 'ask_user',
      content: { status: 'answered', answers: [{ id: 'framework', value: 'Vue' }] },
    })).toBe(false)
    expect((await getMessage(db, waiting.id, 1))!.parts.at(-1)).toMatchObject({ content: { status: 'cancelled' } })
  })

  it('allows an ordinary send after every parent tool call has a terminal result', async () => {
    const providerId = await seedProvider('resolved-send-provider', 'resolved-send-model', false, { tool_call: true })
    const db = createDb(env.DB)
    const conversation = await createConversation(db, {
      user_id: 1, title: 'resolved', provider_id: providerId, model_id: 'resolved-send-model',
    })
    const resolved = await insertMessage(db, 1, {
      conversation_id: conversation.id, parent_id: null, seq: 1, role: 'assistant', status: 'done', error: null,
      provider_id: providerId, model_id: 'resolved-send-model', usage: null, created_at: 0,
      parts: [
        { type: 'tool_call', id: 'cancelled-call', name: 'ask_user', args: ASK_USER_INPUT },
        {
          type: 'tool_result', call_id: 'cancelled-call', name: 'ask_user',
          content: { status: 'cancelled', message: '用户选择了取消回答' },
        },
      ],
    })
    await updateConversation(db, conversation.id, 1, { head_message_id: resolved.id })
    const created = await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: STREAM, chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: conversation.id, parent_id: resolved.id,
      parts: [{ type: 'text', text: 'continue after cancel' }], provider_id: providerId, model_id: 'resolved-send-model',
    }))
    expect(await c.next('message.done')).toMatchObject({ status: 'done' })
    expect(created).toHaveLength(1)
  })

  it('rejects a stale ordinary send whose resolved parent is no longer the Conversation head', async () => {
    const providerId = await seedProvider('stale-resolved-provider', 'stale-resolved-model', false, { tool_call: true })
    const db = createDb(env.DB)
    const conversation = await createConversation(db, {
      user_id: 1, title: 'advanced', provider_id: providerId, model_id: 'stale-resolved-model',
    })
    const oldParent = await insertMessage(db, 1, {
      conversation_id: conversation.id, parent_id: null, seq: 1, role: 'assistant', status: 'done', error: null,
      provider_id: providerId, model_id: 'stale-resolved-model', usage: null, created_at: 0,
      parts: [{ type: 'text', text: 'old' }],
    })
    const newer = await insertMessage(db, 1, {
      conversation_id: conversation.id, parent_id: oldParent.id, seq: 2, role: 'user', status: 'done', error: null,
      provider_id: null, model_id: null, usage: null, created_at: 1, parts: [{ type: 'text', text: 'newer' }],
    })
    await updateConversation(db, conversation.id, 1, { head_message_id: newer.id })
    const created = await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: STREAM, chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', request_id: 'stale-resolved', conversation_id: conversation.id, parent_id: oldParent.id,
      parts: [{ type: 'text', text: 'stale reply' }], provider_id: providerId, model_id: 'stale-resolved-model',
    }))
    expect(await c.next('error')).toMatchObject({ request_id: 'stale-resolved', message: expect.stringMatching(/head|resync/i) })
    expect(await listMessages(db, conversation.id, 1)).toHaveLength(2)
    expect(created).toHaveLength(0)
  })

  it('deletes an unreachable continuation shell when the head advances between child insert and head CAS', async () => {
    const providerId = await seedProvider('child-cas-provider', 'child-cas-model', false, { tool_call: true })
    const db = createDb(env.DB)
    const conversation = await createConversation(db, {
      user_id: 1, title: 'child race', provider_id: providerId, model_id: 'child-cas-model',
    })
    const toolMessage = await insertMessage(db, 1, {
      conversation_id: conversation.id, parent_id: null, seq: 1, role: 'assistant', status: 'done', error: null,
      provider_id: providerId, model_id: 'child-cas-model', usage: null, created_at: 0,
      parts: [
        { type: 'tool_call', id: 'child-race', name: 'ask_user', args: ASK_USER_INPUT },
        {
          type: 'tool_result', call_id: 'child-race', name: 'ask_user',
          content: { status: 'answered', answers: [{ id: 'framework', value: 'Vue' }] },
        },
      ],
    })
    const newer = await insertMessage(db, 1, {
      conversation_id: conversation.id, parent_id: toolMessage.id, seq: 2, role: 'user', status: 'done', error: null,
      provider_id: null, model_id: null, usage: null, created_at: 1, parts: [{ type: 'text', text: 'new head' }],
    })
    await updateConversation(db, conversation.id, 1, { head_message_id: toolMessage.id })
    await db.$client.prepare(`
      CREATE TRIGGER continuation_head_race AFTER INSERT ON messages
      WHEN NEW.parent_id = ${toolMessage.id} AND NEW.role = 'assistant'
      BEGIN
        UPDATE conversations SET head_message_id = ${newer.id} WHERE id = ${conversation.id};
      END
    `).run()
    const created = await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: STREAM, chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const c = await connect(await seedTestUser())
    c.events.length = 0
    try {
      await runInDurableObject(env.USER_HUB.getByName(String(1)), async (instance: UserHub) => {
        await instance.app.hub.handleCommand(instance.app.hub.state.getWebSockets()[0]!, JSON.stringify({
          type: 'tool.continue', request_id: 'child-race', message_id: toolMessage.id,
        }))
      })
    } finally {
      await db.$client.exec('DROP TRIGGER continuation_head_race')
    }
    expect((await getConversation(db, conversation.id, 1))!.head_message_id).toBe(newer.id)
    expect(await listMessages(db, conversation.id, 1)).toHaveLength(2)
    expect(created).toHaveLength(0)
    expect(c.events.some(event => event.type === 'message.created' || event.type === 'head.changed')).toBe(false)
  })

  it('keeps and generates the inserted continuation when a concurrent recovery already moved head to it', async () => {
    const providerId = await seedProvider('child-recovered-provider', 'child-recovered-model', false, { tool_call: true })
    const db = createDb(env.DB)
    const conversation = await createConversation(db, {
      user_id: 1, title: 'child recovered', provider_id: providerId, model_id: 'child-recovered-model',
    })
    const toolMessage = await insertMessage(db, 1, {
      conversation_id: conversation.id, parent_id: null, seq: 1, role: 'assistant', status: 'done', error: null,
      provider_id: providerId, model_id: 'child-recovered-model', usage: null, created_at: 0,
      parts: [
        { type: 'tool_call', id: 'recovered-race', name: 'ask_user', args: ASK_USER_INPUT },
        {
          type: 'tool_result', call_id: 'recovered-race', name: 'ask_user',
          content: { status: 'answered', answers: [{ id: 'framework', value: 'Vue' }] },
        },
      ],
    })
    await updateConversation(db, conversation.id, 1, { head_message_id: toolMessage.id })
    await db.$client.prepare(`
      CREATE TRIGGER continuation_recovered_race AFTER INSERT ON messages
      WHEN NEW.parent_id = ${toolMessage.id} AND NEW.role = 'assistant'
      BEGIN
        UPDATE conversations SET head_message_id = NEW.id WHERE id = ${conversation.id};
      END
    `).run()
    const created = await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: STREAM, chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const c = await connect(await seedTestUser())
    c.events.length = 0
    try {
      await runInDurableObject(env.USER_HUB.getByName(String(1)), async (instance: UserHub) => {
        await instance.app.hub.handleCommand(instance.app.hub.state.getWebSockets()[0]!, JSON.stringify({
          type: 'tool.continue', request_id: 'recovered-race', message_id: toolMessage.id,
        }))
      })
    } finally {
      await db.$client.exec('DROP TRIGGER continuation_recovered_race')
    }
    const rows = await listMessages(db, conversation.id, 1)
    expect(rows).toHaveLength(2)
    expect((await getConversation(db, conversation.id, 1))!.head_message_id).toBe(rows[1]!.id)
    expect(rows[1]).toMatchObject({ parent_id: toolMessage.id, status: 'done' })
    expect(created).toHaveLength(1)
    expect(c.events.some(event => event.type === 'message.created')).toBe(true)
    expect(c.events.some(event => event.type === 'message.done')).toBe(true)
  })

  it('conditional shell cleanup preserves a child claimed by recovery before cleanup starts', async () => {
    const db = createDb(env.DB)
    await seedTestUser(db)
    const conversation = await createConversation(db, {
      user_id: 1, title: 'cleanup race', provider_id: null, model_id: null,
    })
    const parent = await insertMessage(db, 1, {
      conversation_id: conversation.id, parent_id: null, seq: 1, role: 'assistant', status: 'done', error: null,
      provider_id: null, model_id: null, usage: null, created_at: 0, parts: [{ type: 'text', text: 'parent' }],
    })
    const child = await insertMessage(db, 1, {
      conversation_id: conversation.id, parent_id: parent.id, seq: 2, role: 'assistant', status: 'error', error: 'interrupted',
      provider_id: null, model_id: null, usage: null, created_at: 1, parts: [],
    })
    await updateConversation(db, conversation.id, 1, { head_message_id: child.id })

    expect(await deleteMessageIfUnreferenced(db, child.id, 1)).toBe(false)
    expect(await getMessage(db, child.id, 1)).toBeDefined()
    expect((await getConversation(db, conversation.id, 1))!.head_message_id).toBe(child.id)
  })

  it('publishes the reserved user head when assistant shell creation fails', async () => {
    const providerId = await seedProvider('shell-failure-provider', 'shell-failure-model', false, {})
    const db = createDb(env.DB)
    const conversation = await createConversation(db, {
      user_id: 1, title: 'shell failure', provider_id: providerId, model_id: 'shell-failure-model',
    })
    await db.$client.prepare(`
      CREATE TRIGGER fail_assistant_shell BEFORE INSERT ON messages
      WHEN NEW.conversation_id = ${conversation.id} AND NEW.role = 'assistant'
      BEGIN
        SELECT RAISE(ABORT, 'assistant shell failed');
      END
    `).run()
    const c = await connect(await seedTestUser())
    c.events.length = 0
    try {
      c.ws.send(JSON.stringify({
        type: 'send', request_id: 'shell-failure', conversation_id: conversation.id, parent_id: null,
        parts: [{ type: 'text', text: 'persist me' }], provider_id: providerId, model_id: 'shell-failure-model',
      }))
      expect(await c.next('error')).toMatchObject({ request_id: 'shell-failure' })
    } finally {
      await db.$client.exec('DROP TRIGGER fail_assistant_shell')
    }
    const rows = await listMessages(db, conversation.id, 1)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'persist me' }] })
    expect((await getConversation(db, conversation.id, 1))!.head_message_id).toBe(rows[0]!.id)
    expect(c.events.find(event => event.type === 'head.changed')).toMatchObject({ message_id: rows[0]!.id })
    expect(c.events.find(event => event.type === 'conversation.updated')).toMatchObject({ conversation: { head_message_id: rows[0]!.id } })
  })

  it('does not persist a stale user reply when the head advances immediately after implicit skip CAS', async () => {
    const providerId = await seedProvider('skip-head-race-provider', 'skip-head-race-model', false, { tool_call: true })
    const db = createDb(env.DB)
    const conversation = await createConversation(db, {
      user_id: 1, title: 'skip race', provider_id: providerId, model_id: 'skip-head-race-model',
    })
    const waiting = await insertMessage(db, 1, {
      conversation_id: conversation.id, parent_id: null, seq: 1, role: 'assistant', status: 'done', error: null,
      provider_id: providerId, model_id: 'skip-head-race-model', usage: null, created_at: 0,
      parts: [{ type: 'tool_call', id: 'skip-race', name: 'ask_user', args: ASK_USER_INPUT }],
    })
    const newer = await insertMessage(db, 1, {
      conversation_id: conversation.id, parent_id: waiting.id, seq: 2, role: 'user', status: 'done', error: null,
      provider_id: null, model_id: null, usage: null, created_at: 1, parts: [{ type: 'text', text: 'won race' }],
    })
    await updateConversation(db, conversation.id, 1, { head_message_id: waiting.id })
    await db.$client.prepare(`
      CREATE TRIGGER skip_head_race AFTER UPDATE OF parts ON messages
      WHEN NEW.id = ${waiting.id}
      BEGIN
        UPDATE conversations SET head_message_id = ${newer.id} WHERE id = ${conversation.id};
      END
    `).run()
    const created = await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: STREAM, chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const c = await connect(await seedTestUser())
    try {
      c.ws.send(JSON.stringify({
        type: 'send', request_id: 'skip-head-race', conversation_id: conversation.id, parent_id: waiting.id,
        parts: [{ type: 'text', text: 'must not persist' }], provider_id: providerId, model_id: 'skip-head-race-model',
      }))
      await c.next('message.part')
      expect(await c.next('error')).toMatchObject({ request_id: 'skip-head-race' })
    } finally {
      await db.$client.exec('DROP TRIGGER skip_head_race')
    }
    expect((await getConversation(db, conversation.id, 1))!.head_message_id).toBe(newer.id)
    expect(await listMessages(db, conversation.id, 1)).toHaveLength(2)
    expect(created).toHaveLength(0)
  })

  it('streams a reply to every socket and persists it', async () => {
    const providerId = await seedProvider()
    const created = await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: [...STREAM], chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const a = await connect(await seedTestUser())
    const b = await connect(await seedTestUser())
    a.ws.send(JSON.stringify({ type: 'send', request_id: 'r1', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi there' }], provider_id: providerId, model_id: 'mock-1' }))
    const done = await a.next('message.done')
    expect(done).toMatchObject({ type: 'message.done', status: 'done', usage: { prompt: 10, completion: 5, cached: 2, reasoning: 2 }, error: null })

    const types = a.events.map((e) => e.type)
    expect(types.slice(0, 8)).toEqual([
      'snapshot', 'conversation.created', 'message.created', 'head.changed', 'conversation.updated',
      'message.created', 'head.changed', 'conversation.updated',
    ])
    expect(types.filter((t) => t === 'message.delta')).toHaveLength(3)
    await b.next('message.done')
    expect(b.events.filter((e) => e.type === 'message.delta')).toEqual(a.events.filter((e) => e.type === 'message.delta'))

    const created1 = a.events.find((e) => e.type === 'conversation.created')!
    const conversationId = (created1 as { conversation: { id: number; title: string } }).conversation.id
    expect((created1 as { conversation: { title: string } }).conversation.title).toBe('hi there')
    const rows = await listMessages(createDb(env.DB), conversationId, 1)
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant'])
    expect(untimed(rows[1]!.parts)).toEqual([
      { type: 'reasoning', text: 'think', providerOptions: { anthropic: { signature: 'SIG' } } },
      { type: 'text', text: 'Hello, world!' },
    ])
    expect(rows[1]!.status).toBe('done')
    expect(created[0]!.doStreamCalls[0]!.prompt.at(-1)).toMatchObject({ role: 'user' })
  })

  it('regenerate creates a sibling and moves the head; edit creates a sibling user message', async () => {
    const providerId = await seedProvider()
    await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: [...STREAM], chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({ type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'q' }], provider_id: providerId, model_id: 'mock-1' }))
    await c.next('message.done')
    const firstAssistant = (c.events.filter((e) => e.type === 'message.created')[1] as { message: { id: number; conversation_id: number; parent_id: number } }).message
    c.events.length = 0
    c.ws.send(JSON.stringify({ type: 'regenerate', message_id: firstAssistant.id }))
    await c.next('message.done')
    const regen = (c.events.find((e) => e.type === 'message.created') as { message: { id: number; parent_id: number } }).message
    expect(regen.parent_id).toBe(firstAssistant.parent_id)
    expect(regen.id).not.toBe(firstAssistant.id)
    expect(c.events.find((e) => e.type === 'head.changed')).toMatchObject({ message_id: regen.id })

    c.events.length = 0
    c.ws.send(JSON.stringify({ type: 'edit', message_id: firstAssistant.parent_id, parts: [{ type: 'text', text: 'q2' }] }))
    await c.next('message.done')
    const createdMsgs = c.events.filter((e) => e.type === 'message.created') as Array<{ message: { role: string; parent_id: number | null; parts: unknown } }>
    expect(createdMsgs[0]!.message).toMatchObject({ role: 'user', parent_id: null, parts: [{ type: 'text', text: 'q2' }] })
    expect(createdMsgs[1]!.message.role).toBe('assistant')
  })

  it('stop aborts and keeps partial text', async () => {
    const providerId = await seedProvider()
    await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: [...STREAM], chunkDelayInMs: 200, initialDelayInMs: null }) }),
    }))
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({ type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'slow' }], provider_id: providerId, model_id: 'mock-1' }))
    await c.next('message.delta')
    const conversationId = (c.events.find((e) => e.type === 'conversation.created') as { conversation: { id: number } }).conversation.id
    c.ws.send(JSON.stringify({ type: 'stop', conversation_id: conversationId }))
    const done = await c.next('message.done')
    // An aborted stream never emits `finish`, so usage is genuinely unknown rather than zero.
    expect(done).toMatchObject({ status: 'aborted', usage: null })
    const rows = await listMessages(createDb(env.DB), conversationId, 1)
    expect(rows[1]!.status).toBe('aborted')
    // The delta we waited for is already accumulated, so the partial content must survive the abort.
    expect(rows[1]!.parts.length).toBeGreaterThan(0)
  })

  it('reports provider errors as status error', async () => {
    const providerId = await seedProvider()
    await installMock(() => new MockLanguageModelV4({ doStream: async () => { throw new Error('boom 401') } }))
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({ type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'x' }], provider_id: providerId, model_id: 'mock-1' }))
    const done = await c.next('message.done')
    expect(done).toMatchObject({ status: 'error', error: expect.stringContaining('boom 401') })
  })
})

describe('project inheritance', () => {
  /** A fresh mock that always returns the canned stream, so calls can be inspected afterwards. */
  const streamingMock = () => new MockLanguageModelV4({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: [...STREAM], chunkDelayInMs: null, initialDelayInMs: null }) }),
  })

  it('inherits the Project prompt, model and params without copying them into the conversation', async () => {
    const projectProvider = await seedProvider('project-provider', 'model-a')
    const commandProvider = await seedProvider('command-provider', 'model-b')
    const projectId = await seedProject({
      system_prompt: 'PROJECT', provider_id: projectProvider, model_id: 'model-a',
      params: { temperature: 0.5, max_tokens: 64, reasoning_effort: 'high' },
    })
    const created = await installMock(streamingMock)
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
      // The command's model is the last fallback; the Project default must win over it.
      provider_id: commandProvider, model_id: 'model-b',
      project_id: projectId, system_prompt: 'CONVERSATION', params: { top_p: 0.25, temperature: 0 },
    }))
    expect(await c.next('message.done')).toMatchObject({ status: 'done' })

    const call = created[0]!.doStreamCalls[0]!
    expect(call.prompt[0]).toMatchObject({ role: 'system', content: 'PROJECT\n\nCONVERSATION' })
    // temperature: 0 is a real conversation override, not an absent value.
    expect(call).toMatchObject({ temperature: 0, topP: 0.25, maxOutputTokens: 64 })

    const conversationId = (c.events.find((e) => e.type === 'conversation.created') as { conversation: { id: number } }).conversation.id
    const row = (await getConversation(createDb(env.DB), conversationId, 1))!
    expect(row.project_id).toBe(projectId)
    expect(row.system_prompt).toBe('CONVERSATION')
    expect(row.params).toEqual({ top_p: 0.25, temperature: 0 })
    // Inherited values are never copied down, and the generation-time model is never persisted.
    expect(row.provider_id).toBeNull()
    expect(row.model_id).toBeNull()

    const rows = await listMessages(createDb(env.DB), conversationId, 1)
    expect(rows[1]).toMatchObject({ provider_id: projectProvider, model_id: 'model-a' })
  })

  it('prefers the conversation override over the Project default and persists it', async () => {
    const projectProvider = await seedProvider('project-provider', 'model-a')
    const conversationProvider = await seedProvider('conversation-provider', 'model-b')
    const projectId = await seedProject({ provider_id: projectProvider, model_id: 'model-a' })
    await installMock(streamingMock)
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
      provider_id: projectProvider, model_id: 'model-a',
      project_id: projectId, conversation_provider_id: conversationProvider, conversation_model_id: 'model-b',
    }))
    await c.next('message.done')

    const conversationId = (c.events.find((e) => e.type === 'conversation.created') as { conversation: { id: number } }).conversation.id
    const row = (await getConversation(createDb(env.DB), conversationId, 1))!
    expect(row).toMatchObject({ provider_id: conversationProvider, model_id: 'model-b' })
    const rows = await listMessages(createDb(env.DB), conversationId, 1)
    expect(rows[1]).toMatchObject({ provider_id: conversationProvider, model_id: 'model-b' })
  })

  it('picks up a Project edit on the next generation of an existing conversation', async () => {
    const providerId = await seedProvider()
    const projectId = await seedProject({ system_prompt: 'FIRST' })
    const created = await installMock(streamingMock)
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'a' }],
      provider_id: providerId, model_id: 'mock-1', project_id: projectId,
    }))
    await c.next('message.done')
    const conversationId = (c.events.find((e) => e.type === 'conversation.created') as { conversation: { id: number } }).conversation.id

    await createDb(env.DB).update(projects).set({ system_prompt: 'SECOND' }).where(eq(projects.id, projectId))
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: conversationId, parent_id: null, parts: [{ type: 'text', text: 'b' }],
      provider_id: providerId, model_id: 'mock-1',
    }))
    await c.nextAfter('message.done', 2)
    expect(created[0]!.doStreamCalls[0]!.prompt[0]).toMatchObject({ content: 'FIRST' })
    expect(created[1]!.doStreamCalls[0]!.prompt[0]).toMatchObject({ content: 'SECOND' })
  })

  it('lets an explicit regenerate model outrank the conversation override and the Project default', async () => {
    const projectProvider = await seedProvider('project-provider', 'model-a')
    const conversationProvider = await seedProvider('conversation-provider', 'model-b')
    const pickedProvider = await seedProvider('picked-provider', 'model-c')
    const projectId = await seedProject({ system_prompt: 'PROJECT', provider_id: projectProvider, model_id: 'model-a', params: { temperature: 0.4 } })
    const created = await installMock(streamingMock)
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
      provider_id: projectProvider, model_id: 'model-a',
      project_id: projectId, conversation_provider_id: conversationProvider, conversation_model_id: 'model-b',
    }))
    await c.next('message.done')
    const first = (c.events.filter((e) => e.type === 'message.created')[1] as { message: { id: number; conversation_id: number } }).message

    c.ws.send(JSON.stringify({ type: 'regenerate', message_id: first.id, provider_id: pickedProvider, model_id: 'model-c' }))
    await c.nextAfter('message.done', 2)

    const rows = await listMessages(createDb(env.DB), first.conversation_id, 1)
    expect(rows[1]).toMatchObject({ provider_id: conversationProvider, model_id: 'model-b' })
    // The one-shot choice wins outright — it is not the lowest fallback layer.
    expect(rows[2]).toMatchObject({ provider_id: pickedProvider, model_id: 'model-c' })
    // ...and it is never persisted onto the conversation, which keeps its own override.
    expect(await getConversation(createDb(env.DB), first.conversation_id, 1)).toMatchObject({ provider_id: conversationProvider, model_id: 'model-b' })
    // Prompt and params still inherit from the Project on the regenerated turn.
    expect(created[1]!.doStreamCalls[0]!.prompt[0]).toMatchObject({ role: 'system', content: 'PROJECT' })
    expect(created[1]!.doStreamCalls[0]).toMatchObject({ temperature: 0.4 })
  })

  it('lets an explicit edit model outrank the conversation override', async () => {
    const conversationProvider = await seedProvider('conversation-provider', 'model-b')
    const pickedProvider = await seedProvider('picked-provider', 'model-c')
    await installMock(streamingMock)
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
      provider_id: conversationProvider, model_id: 'model-b',
      conversation_provider_id: conversationProvider, conversation_model_id: 'model-b',
    }))
    await c.next('message.done')
    const first = (c.events.filter((e) => e.type === 'message.created')[0] as { message: { id: number; conversation_id: number } }).message

    c.ws.send(JSON.stringify({
      type: 'edit', message_id: first.id, parts: [{ type: 'text', text: 'hi again' }],
      provider_id: pickedProvider, model_id: 'model-c',
    }))
    await c.nextAfter('message.done', 2)

    const rows = await listMessages(createDb(env.DB), first.conversation_id, 1)
    expect(rows[3]).toMatchObject({ role: 'assistant', provider_id: pickedProvider, model_id: 'model-c' })
    // ...and it is never persisted onto the conversation, which keeps its own override.
    expect(await getConversation(createDb(env.DB), first.conversation_id, 1)).toMatchObject({ provider_id: conversationProvider, model_id: 'model-b' })
  })

  it('rejects an unavailable inherited model, naming the layer it came from', async () => {
    const db = createDb(env.DB)
    const projectProvider = await seedProvider('project-provider', 'model-a')
    const commandProvider = await seedProvider('command-provider', 'model-b')
    const projectId = await seedProject({ provider_id: projectProvider, model_id: 'model-a' })
    await db.update(models).set({ enabled: false }).where(eq(models.provider_id, projectProvider))
    await installMock(streamingMock)

    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', request_id: 'p1', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
      provider_id: commandProvider, model_id: 'model-b', project_id: projectId,
    }))
    expect(await c.next('error')).toMatchObject({ request_id: 'p1', message: '模型不可用（来源：Project）' })
    // No half-made conversation and no orphan message may survive a rejected generation.
    expect(c.events.some((e) => e.type === 'conversation.created' || e.type === 'message.created')).toBe(false)

    c.ws.send(JSON.stringify({
      type: 'send', request_id: 's1', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
      provider_id: commandProvider, model_id: 'model-b',
      conversation_provider_id: projectProvider, conversation_model_id: 'model-a',
    }))
    expect(await c.nextAfter('error', 2)).toMatchObject({ request_id: 's1', message: '模型不可用（来源：会话）' })
  })

  it('rejects a Project owned by another user', async () => {
    const db = createDb(env.DB)
    const providerId = await seedProvider()
    const [other] = await db.insert(users).values({ name: 'other', settings: { plugins: {} }, createdAt: new Date(0), updatedAt: new Date(0), email: crypto.randomUUID() + '@example.com' }).returning()
    const projectId = await seedProject({ user_id: other!.id })
    await installMock(streamingMock)
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', request_id: 'x1', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
      provider_id: providerId, model_id: 'mock-1', project_id: projectId,
    }))
    expect(await c.next('error')).toMatchObject({ request_id: 'x1', message: 'project not found' })
    expect(c.events.some((e) => e.type === 'conversation.created')).toBe(false)
  })

  it('rejects conversation-init fields sent alongside an existing conversation_id', async () => {
    const providerId = await seedProvider()
    await installMock(streamingMock)
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
      provider_id: providerId, model_id: 'mock-1',
    }))
    await c.next('message.done')
    const conversationId = (c.events.find((e) => e.type === 'conversation.created') as { conversation: { id: number } }).conversation.id

    c.ws.send(JSON.stringify({
      type: 'send', request_id: 'i1', conversation_id: conversationId, parent_id: null, parts: [{ type: 'text', text: 'again' }],
      provider_id: providerId, model_id: 'mock-1', system_prompt: 'ignored',
    }))
    const err = await c.next('error')
    expect(err).toMatchObject({ request_id: 'i1' })
    expect((err as { message: string }).message).toContain('conversation init fields')
    // The rejected command must not have persisted anything.
    expect(await listMessages(createDb(env.DB), conversationId, 1)).toHaveLength(2)
  })

  it('accepts the Composer’s own payloads: the draft creates the conversation, the follow-up omits every init field', async () => {
    // The client builds these commands; a follow-up that nulled the init fields out instead of
    // omitting them would be rejected by the check above, so the builder is exercised end to end.
    const providerId = await seedProvider()
    const projectId = await seedProject({ system_prompt: 'PROJECT' })
    const created = await installMock(streamingMock)
    const c = await connect(await seedTestUser())
    const model = { provider_id: providerId, model_id: 'mock-1' }
    c.ws.send(JSON.stringify(sendCommandFor({
      conversationId: null, parentId: null, parts: [{ type: 'text', text: 'first' }], model,
      draft: { project_id: projectId, system_prompt: 'DRAFT', model: null, params: { reasoning_enabled: true, reasoning_effort: null } },
    })))
    expect(await c.next('message.done')).toMatchObject({ status: 'done' })

    const conversationId = (c.events.find((e) => e.type === 'conversation.created') as { conversation: { id: number } }).conversation.id
    const row = (await getConversation(createDb(env.DB), conversationId, 1))!
    expect(row).toMatchObject({ project_id: projectId, system_prompt: 'DRAFT', provider_id: null, model_id: null })
    // Explicit Auto survives the round trip as `null`, not as an absent (inherited) key.
    expect(row.params).toEqual({ reasoning_enabled: true, reasoning_effort: null })
    expect(created[0]!.doStreamCalls[0]!.prompt[0]).toMatchObject({ role: 'system', content: 'PROJECT\n\nDRAFT' })

    c.ws.send(JSON.stringify(sendCommandFor({
      conversationId, parentId: row.head_message_id, parts: [{ type: 'text', text: 'second' }], model,
      draft: { project_id: projectId, system_prompt: 'DRAFT', model: null, params: null },
    })))
    expect(await c.nextAfter('message.done', 2)).toMatchObject({ status: 'done' })
    expect(c.events.some((e) => e.type === 'error')).toBe(false)
    expect(await listMessages(createDb(env.DB), conversationId, 1)).toHaveLength(4)
  })
})

describe('effective model interface', () => {
  it('follows the default interface, honors a model override and maps resolved metadata to that protocol', async () => {
    const db = createDb(env.DB)
    const providerId = await seedProvider('interfaces', 'mock-1', false, {
      reasoning: true, reasoning_options: [{ type: 'effort', values: ['high'] }],
    })
    const [other] = await db.insert(providerInterfaces).values({ provider_id: providerId, protocol: 'anthropic', base_url: 'https://anthropic.example/v1', native_files: false, created_at: 0 }).returning()
    const created = await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: [...STREAM], chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const selected: ProviderInterfaceRow[] = []
    await runInDurableObject(env.USER_HUB.getByName(String(1)), async (instance: UserHub) => {
      instance.app.llm.register('anthropic', {
        createModel(_provider, providerInterface) {
          selected.push(providerInterface)
          const model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: [...STREAM], chunkDelayInMs: null, initialDelayInMs: null }) }) })
          created.push(model)
          return model
        },
      })
    })
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({ type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'first' }], provider_id: providerId, model_id: 'mock-1', params: { reasoning_effort: 'high' } }))
    expect(await c.next('message.done')).toMatchObject({ status: 'done' })
    expect(created[0]!.doStreamCalls[0]!.providerOptions).toEqual({ responses: { reasoningEffort: 'high' } })
    const conversationId = conversationIdOf(c)
    await db.update(models).set({ interface_id: other!.id }).where(eq(models.provider_id, providerId))
    c.ws.send(JSON.stringify({ type: 'send', conversation_id: conversationId, parent_id: null, parts: [{ type: 'text', text: 'second' }], provider_id: providerId, model_id: 'mock-1' }))
    expect(await c.nextAfter('message.done', 2)).toMatchObject({ status: 'done' })
    expect(selected).toMatchObject([{ id: other!.id, protocol: 'anthropic', base_url: 'https://anthropic.example/v1' }])
    expect(created[1]!.doStreamCalls[0]!.providerOptions).toEqual({ anthropic: { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'high' } })
  })

  it('rejects a missing effective interface before persisting a conversation or messages', async () => {
    const providerId = await seedProvider('no-default')
    await createDb(env.DB).update(providers).set({ default_interface_id: null }).where(eq(providers.id, providerId))
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({ type: 'send', request_id: 'missing-interface', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'first' }], provider_id: providerId, model_id: 'mock-1' }))
    expect(await Promise.race([c.next('error'), c.next('message.done')])).toMatchObject({ request_id: 'missing-interface', message: expect.stringMatching(/interface/) })
    expect(c.events.some(event => event.type === 'conversation.created' || event.type === 'message.created')).toBe(false)
  })
})

describe('DeepSeek Responses reasoning lifecycle', () => {
  it.each([
    { metadataPresent: true, omitReasoningContent: false },
    { metadataPresent: false, omitReasoningContent: false },
    { metadataPresent: true, omitReasoningContent: true },
    { metadataPresent: false, omitReasoningContent: true },
  ])('streams full reasoning through live events and D1, then replays it with thinking disabled (metadata: $metadataPresent, content omitted: $omitReasoningContent)', async ({ metadataPresent, omitReasoningContent }) => {
    const db = createDb(env.DB)
    const providerId = await seedProvider('deepseek', 'deepseek-fixture', false, {
      reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'high'] }],
    })
    const requests: Array<{ url: string; body: { input: unknown[]; reasoning?: unknown } }> = []
    await runInDurableObject(env.USER_HUB.getByName(String(1)), async (instance: UserHub) => {
      instance.app.llm.register('responses', {
        createModel(_provider, selected, model, apiKey) {
          return createOpenResponses({
            name: 'responses', url: `${selected.base_url}/responses`, apiKey,
            fetch: async (input, init) => {
              const request = new Request(input, init)
              requests.push({ url: request.url, body: await request.json() })
              return deepseekResponsesStream({ omitReasoningContent })
            },
          })(model.model_id)
        },
      })
    })
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({ type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'first' }], provider_id: providerId, model_id: 'deepseek-fixture', params: { reasoning_effort: 'high' } }))
    expect(await c.next('message.done')).toMatchObject({ status: 'done', usage: { prompt: 11, completion: 9, cached: 3, reasoning: 6 } })
    const conversationId = conversationIdOf(c)
    const saved = (await listMessages(db, conversationId, 1))[1]!
    expect(saved.parts.map(part => part.type)).toEqual(['reasoning', 'tool_call', 'text'])
    expect(untimed(saved.parts[0])).toEqual({
      type: 'reasoning', text: 'complete reasoning', providerOptions: { responses: {
        itemId: 'rs_fixture', reasoningSummary: deepseekReasoningItem.summary,
        reasoningContent: deepseekReasoningItem.content, reasoningEncryptedContent: 'fixture-encrypted-state',
      } },
    })
    const live: Part[] = []
    for (const event of c.events) {
      if (event.type === 'message.part' && event.message_id === saved.id) live[event.part_index] = event.part
      if (event.type === 'message.delta' && event.message_id === saved.id) {
        const part = live[event.part_index]
        if (!part || (part.type !== 'text' && part.type !== 'reasoning')) throw new Error('missing streamed part')
        part.text += event.delta
      }
    }
    expect(live).toEqual(saved.parts)
    // Tool execution is external to this fixture; complete its persisted result before the next turn.
    await finalizeMessage(db, saved.id, 1, { parts: [...saved.parts, { type: 'tool_result', call_id: 'call_fixture', name: 'lookup', content: { found: true } }], usage: saved.usage, status: 'done', error: null })
    if (!metadataPresent) await db.update(models).set({ metadata_resolved: {} }).where(eq(models.provider_id, providerId))
    await updateConversation(db, conversationId, 1, { params: { reasoning_enabled: false, reasoning_effort: 'high' } })
    c.ws.send(JSON.stringify({ type: 'send', conversation_id: conversationId, parent_id: null, parts: [{ type: 'text', text: 'next' }], provider_id: providerId, model_id: 'deepseek-fixture' }))
    expect(await c.nextAfter('message.done', 2)).toMatchObject({ status: 'done' })
    expect(requests.map(request => request.body.reasoning)).toEqual([{ effort: 'high' }, metadataPresent ? { effort: 'none' } : undefined])
    expect(requests[1]!.body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first' }] },
      { type: 'reasoning', id: 'rs_fixture', summary: deepseekReasoningItem.summary, content: deepseekReasoningItem.content, encrypted_content: 'fixture-encrypted-state' },
      { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'lookup', arguments: '{"q":"fixture"}' },
      { type: 'message', role: 'assistant', id: 'msg_fixture', content: [{ type: 'output_text', text: 'fixture answer' }] },
      { type: 'function_call_output', call_id: 'call_fixture', output: '{"found":true}' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] },
    ])
    expect(untimed((await listMessages(db, conversationId, 1))[3]!.parts)).toEqual(untimed(saved.parts))
  })
})

describe('provider metadata round trip', () => {
  /** Responses can return an empty visible block with encrypted state that still needs replay. */
  const META_STREAM: StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: 'r', modelId: 'mock', timestamp: new Date(0) },
    { type: 'reasoning-start', id: 'r1', providerMetadata: { responses: { itemId: 'rs_1' } } },
    { type: 'reasoning-end', id: 'r1', providerMetadata: { responses: { itemId: 'rs_1', reasoningEncryptedContent: 'ENC' } } },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Hello' },
    // Gemini hangs its thought signature off the text block, not the reasoning block.
    { type: 'text-end', id: 't1', providerMetadata: { google: { thoughtSignature: 'TS_TEXT' } } },
    STREAM.at(-1)!,
  ]

  it('persists stream metadata and replays it on the next turn', async () => {
    const providerId = await seedProvider()
    const created = await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: [...META_STREAM], chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({ type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }], provider_id: providerId, model_id: 'mock-1' }))
    await c.next('message.done')
    const conversationId = (c.events.find((e) => e.type === 'conversation.created') as { conversation: { id: number } }).conversation.id

    const stored: Part[] = [
      { type: 'reasoning', text: '', providerOptions: { responses: { itemId: 'rs_1', reasoningEncryptedContent: 'ENC' } } },
      { type: 'text', text: 'Hello', providerOptions: { google: { thoughtSignature: 'TS_TEXT' } } },
    ]
    // An empty summary is not an absent round trip: the encrypted item still has to reach D1.
    expect(untimed((await listMessages(createDb(env.DB), conversationId, 1))[1]!.parts)).toEqual(untimed(stored))

    c.ws.send(JSON.stringify({ type: 'send', conversation_id: conversationId, parent_id: null, parts: [{ type: 'text', text: 'more' }], provider_id: providerId, model_id: 'mock-1' }))
    await c.nextAfter('message.done', 2)
    const prompt = created[1]!.doStreamCalls[0]!.prompt
    expect(prompt.find((m) => m.role === 'assistant')!.content).toEqual([
      { type: 'reasoning', text: '', providerOptions: { responses: { itemId: 'rs_1', reasoningEncryptedContent: 'ENC' } } },
      { type: 'text', text: 'Hello' },
    ])
  })

  it('rebuilds identical model messages from memory and from D1 JSON', async () => {
    const db = createDb(env.DB)
    await seedTestUser(db)
    const conversation = await createConversation(db, { user_id: 1, title: 't', provider_id: null, model_id: null })
    const userParts: Part[] = [{ type: 'text', text: 'q' }]
    const assistantParts: Part[] = [
      { type: 'reasoning', text: 'hmm', providerOptions: { anthropic: { signature: 'SIG', redactedData: 'RED' } } },
      { type: 'text', text: 'a cat', providerOptions: { google: { thoughtSignature: 'TS_TEXT' } } },
      { type: 'tool_call', id: 'call_1', name: 'lookup', args: { q: 'cat' }, providerOptions: { google: { thoughtSignature: 'TS_TOOL' } } },
      { type: 'tool_result', call_id: 'call_1', name: 'lookup', content: { ok: true } },
    ]
    const base = { conversation_id: conversation.id, provider_id: null, model_id: null, usage: null, status: 'done' as const, error: null, created_at: 0 }
    const user = await insertMessage(db, 1, { ...base, parent_id: null, seq: 0, role: 'user', parts: userParts })
    const assistant = await insertMessage(db, 1, { ...base, parent_id: user.id, seq: 1, role: 'assistant', parts: assistantParts })

    // The literals never left memory; the rows came back out of the D1 JSON column.
    const inMemory: Message[] = [{ ...toMessage(user), parts: userParts }, { ...toMessage(assistant), parts: assistantParts }]
    const fromD1 = (await listMessages(db, conversation.id, 1)).map((r) => toMessage(r))
    expect(fromD1).toEqual(inMemory)
    for (const protocol of ['chat-completions', 'responses', 'anthropic', 'vertex-compatible'] as const) {
      const args = { protocol, systemPrompt: null, attachments: new Map() }
      expect(buildModelMessages({ ...args, path: fromD1 })).toEqual(buildModelMessages({ ...args, path: inMemory }))
    }
  })
})

describe('provider file transport', () => {
  const streamingMock = () => new MockLanguageModelV4({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: [...STREAM], chunkDelayInMs: null, initialDelayInMs: null }) }),
  })

  const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

  // D1 is shared across the tests in this project, so every attachment needs its own hash.
  let attachmentSeq = 0
  async function seedAttachment(): Promise<number> {
    const digest = String(++attachmentSeq).padStart(64, 'a')
    const db = createDb(env.DB)
    await seedTestUser(db)
    const key = `${1}/${digest.slice(0, 2)}/${digest}`
    await env.BUCKET.put(key, PNG, { httpMetadata: { contentType: 'image/png' } })
    const [row] = await db.insert(attachments).values({
      user_id: 1, sha256: digest, mime: 'image/png', size: PNG.byteLength,
      width: 1, height: 1, r2_key: key, origin: 'upload', created_at: 0,
    }).returning()
    return row!.id
  }

  function send(body: Record<string, unknown>): string {
    return JSON.stringify({ type: 'send', conversation_id: null, parent_id: null, ...body })
  }

  it('shares normalized OpenAI scopes across Responses and a model-specific Chat interface', async () => {
    const providerId = await seedProvider('shared-files', 'responses-model', true)
    const db = createDb(env.DB)
    const [chat] = await db.insert(providerInterfaces).values({ provider_id: providerId, protocol: 'chat-completions', base_url: 'https://mock.example/responses-api/', native_files: true, created_at: 0 }).returning()
    await db.insert(models).values({ provider_id: providerId, model_id: 'chat-model', interface_id: chat!.id, enabled: true })
    const attachmentId = await seedAttachment()
    const uploads: Upload[] = []
    const files = recordingFiles(uploads)
    const factory = vi.fn((provider: ProviderRow, _selected: ProviderInterfaceRow) => files(provider))
    const created = await installMock(streamingMock, factory, ['responses', 'chat-completions'])
    const c = await connect(await seedTestUser())
    c.ws.send(send({ parts: [{ type: 'image', attachment_id: attachmentId }, { type: 'image', attachment_id: attachmentId }], provider_id: providerId, model_id: 'responses-model' }))
    expect(await c.next('message.done')).toMatchObject({ status: 'done' })
    await db.update(attachmentProviderFiles).set({ base_url: 'https://MOCK.example:443/old/../responses-api///' }).where(eq(attachmentProviderFiles.attachment_id, attachmentId))
    c.ws.send(send({ conversation_id: conversationIdOf(c), parts: [{ type: 'text', text: 'again' }], provider_id: providerId, model_id: 'chat-model' }))
    expect(await c.nextAfter('message.done', 2)).toMatchObject({ status: 'done' })
    expect(uploads).toHaveLength(1)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(factory.mock.calls[1]![1]).toMatchObject({ id: chat!.id })
    expect(filePartsOf(created[1]!)).toEqual(filePartsOf(created[0]!))
    expect(await pointersOf(attachmentId)).toMatchObject([{ provider_id: providerId, credential_version: 1, file_family: 'openai', base_url: 'https://mock.example/responses-api' }])
  })

  it.each(['credential', 'family', 'baseURL'] as const)('uploads a new pointer when the %s scope changes', async (change) => {
    const providerId = await seedProvider('scoped-files', 'model-a', true)
    const attachmentId = await seedAttachment()
    const uploads: Upload[] = []
    const created = await installMock(streamingMock, recordingFiles(uploads), ['responses', 'anthropic'])
    const c = await connect(await seedTestUser())
    c.ws.send(send({ parts: [{ type: 'image', attachment_id: attachmentId }], provider_id: providerId, model_id: 'model-a' }))
    expect(await c.next('message.done')).toMatchObject({ status: 'done' })
    const original = (await pointersOf(attachmentId))[0]!
    const db = createDb(env.DB)
    if (change === 'credential') await db.update(providers).set({ credential_version: 2 }).where(eq(providers.id, providerId))
    else await db.update(providerInterfaces).set(change === 'family' ? { protocol: 'anthropic' } : { base_url: 'https://other.example/v1' }).where(eq(providerInterfaces.provider_id, providerId))
    c.ws.send(send({ conversation_id: conversationIdOf(c), parts: [{ type: 'text', text: 'again' }], provider_id: providerId, model_id: 'model-a' }))
    expect(await c.nextAfter('message.done', 2)).toMatchObject({ status: 'done' })
    expect(uploads).toHaveLength(2)
    expect(filePartsOf(created[1]!)[0]!.data).toEqual({ type: 'reference', reference: { mock: `file-${providerId}-2` } })
    const rows = await pointersOf(attachmentId)
    expect(rows).toHaveLength(2)
    expect(rows.find(row => row.id === original.id)).toEqual(original)
    const latest = rows.find(row => row.id !== original.id)!
    expect(latest).toMatchObject({ credential_version: change === 'credential' ? 2 : 1, file_family: change === 'family' ? 'anthropic' : 'openai', base_url: change === 'baseURL' ? 'https://other.example/v1' : 'https://mock.example/responses-api' })
    expect(latest.cleanup_after).toBe(latest.expires_at)
    expect(latest.expires_at).toBeGreaterThanOrEqual(latest.created_at + 604_800_000)
  })

  it('inlines bytes when the selected adapter has no Files API', async () => {
    const providerId = await seedProvider('no-files-api', 'model-a', true)
    const attachmentId = await seedAttachment()
    const created = await installMock(streamingMock)
    const c = await connect(await seedTestUser())
    c.ws.send(send({ parts: [{ type: 'image', attachment_id: attachmentId }], provider_id: providerId, model_id: 'model-a' }))
    expect(await c.next('message.done')).toMatchObject({ status: 'done' })
    expect(filePartsOf(created[0]!)).toEqual([{ type: 'file', mediaType: 'image/png', data: { type: 'data', data: PNG } }])
    expect(await pointersOf(attachmentId)).toHaveLength(0)
  })

  it('uploads once per provider and reuses the first pointer when the conversation switches back', async () => {
    const a = await seedProvider('files-a', 'model-a', true)
    const b = await seedProvider('files-b', 'model-b', true)
    const attachmentId = await seedAttachment()
    const uploads: Upload[] = []
    const created = await installMock(streamingMock, recordingFiles(uploads))

    const c = await connect(await seedTestUser())
    c.ws.send(send({ parts: [{ type: 'text', text: 'look' }, { type: 'image', attachment_id: attachmentId }], provider_id: a, model_id: 'model-a' }))
    await c.next('message.done')
    const conversationId = (c.events.find((e) => e.type === 'conversation.created') as { conversation: { id: number } }).conversation.id

    // Same image, now travelling to a different provider: A's id means nothing to B.
    c.ws.send(send({ conversation_id: conversationId, parts: [{ type: 'text', text: 'again' }], provider_id: b, model_id: 'model-b' }))
    await c.nextAfter('message.done', 2)

    // ...and back to A, whose original pointer is still valid.
    c.ws.send(send({ conversation_id: conversationId, parts: [{ type: 'text', text: 'once more' }], provider_id: a, model_id: 'model-a' }))
    await c.nextAfter('message.done', 3)

    expect(uploads.map((u) => u.providerId)).toEqual([a, b])
    expect(uploads[0]!.options).toMatchObject({
      mediaType: 'image/png',
      data: { type: 'data', data: PNG },
      providerOptions: { openai: { purpose: 'user_data', expiresAfter: 604800 } },
    })

    const reference = (id: number, n: number) => ({ type: 'file', mediaType: 'image/png', data: { type: 'reference', reference: { mock: `file-${id}-${n}` } } })
    expect(filePartsOf(created[0]!)).toEqual([reference(a, 1)])
    expect(filePartsOf(created[1]!)).toEqual([reference(b, 1)])
    // The third leg must reuse A's *first* pointer rather than minting a second one.
    expect(filePartsOf(created[2]!)).toEqual([reference(a, 1)])

    const rows = await pointersOf(attachmentId)
    expect(rows.map((r) => r.provider_id).sort()).toEqual([a, b].sort())
    expect(rows.map((r) => r.provider_reference)).toContainEqual({ mock: `file-${a}-1` })
  })

  it('re-uploads expired pointers, retains history and reuses the newest upload', async () => {
    const a = await seedProvider('files-a', 'model-a', true)
    const attachmentId = await seedAttachment()
    const uploads: Upload[] = []
    const created = await installMock(streamingMock, recordingFiles(uploads))

    const c = await connect(await seedTestUser())
    c.ws.send(send({ parts: [{ type: 'text', text: 'look' }, { type: 'image', attachment_id: attachmentId }], provider_id: a, model_id: 'model-a' }))
    await c.next('message.done')
    const conversationId = (c.events.find((e) => e.type === 'conversation.created') as { conversation: { id: number } }).conversation.id

    // An expired pointer must never take part in context assembly, cleanup job or not.
    await createDb(env.DB).update(attachmentProviderFiles).set({ expires_at: Date.now() - 1 })
      .where(eq(attachmentProviderFiles.attachment_id, attachmentId))

    c.ws.send(send({ conversation_id: conversationId, parts: [{ type: 'text', text: 'again' }], provider_id: a, model_id: 'model-a' }))
    await c.nextAfter('message.done', 2)

    expect(uploads.map((u) => u.providerId)).toEqual([a, a])
    expect(filePartsOf(created[1]!)).toEqual([
      { type: 'file', mediaType: 'image/png', data: { type: 'reference', reference: { mock: `file-${a}-2` } } },
    ])
    const rows = await pointersOf(attachmentId)
    expect(rows).toHaveLength(2)
    const newest = rows.find(row => row.provider_reference.mock === `file-${a}-2`)
    expect(newest!.expires_at).toBeGreaterThan(Date.now())
    c.ws.send(send({ conversation_id: conversationId, parts: [{ type: 'text', text: 'reuse' }], provider_id: a, model_id: 'model-a' }))
    await c.nextAfter('message.done', 3)
    expect(uploads).toHaveLength(2)
    expect(filePartsOf(created[2]!)).toEqual([
      { type: 'file', mediaType: 'image/png', data: { type: 'reference', reference: { mock: `file-${a}-2` } } },
    ])
  })

  it('persists the provider-reported expiry, and otherwise the requested seven days', async () => {
    const reported = new Date(Date.now() + 3_600_000)
    const a = await seedProvider('files-a', 'model-a', true)
    const b = await seedProvider('files-b', 'model-b', true)
    const attachmentId = await seedAttachment()
    await installMock(streamingMock, (provider) => recordingFiles([], provider.id === a ? reported : undefined)(provider))

    const c = await connect(await seedTestUser())
    c.ws.send(send({ parts: [{ type: 'text', text: 'look' }, { type: 'image', attachment_id: attachmentId }], provider_id: a, model_id: 'model-a' }))
    await c.next('message.done')
    const conversationId = (c.events.find((e) => e.type === 'conversation.created') as { conversation: { id: number } }).conversation.id
    const before = Date.now()
    c.ws.send(send({ conversation_id: conversationId, parts: [{ type: 'text', text: 'again' }], provider_id: b, model_id: 'model-b' }))
    await c.nextAfter('message.done', 2)

    const rows = await pointersOf(attachmentId)
    expect(rows.find((r) => r.provider_id === a)!.expires_at).toBe(reported.getTime())
    expect(rows.find((r) => r.provider_id === a)!.cleanup_after).toBe(reported.getTime())
    // No reported expiry: the local pointer dies on the deadline the upload asked for.
    const fallback = rows.find((r) => r.provider_id === b)!.expires_at
    expect(fallback).toBeGreaterThanOrEqual(before + 604_800_000)
    expect(fallback).toBeLessThanOrEqual(Date.now() + 604_800_000)
  })

  it('never touches the Files API when the provider has native files disabled', async () => {
    const a = await seedProvider('inline', 'model-a', false)
    const attachmentId = await seedAttachment()
    const createFiles = vi.fn(recordingFiles([]))
    const created = await installMock(streamingMock, createFiles)

    const c = await connect(await seedTestUser())
    c.ws.send(send({ parts: [{ type: 'text', text: 'look' }, { type: 'image', attachment_id: attachmentId }], provider_id: a, model_id: 'model-a' }))
    expect(await c.next('message.done')).toMatchObject({ status: 'done' })

    expect(createFiles).not.toHaveBeenCalled()
    expect(filePartsOf(created[0]!)).toEqual([{ type: 'file', mediaType: 'image/png', data: { type: 'data', data: PNG } }])
    expect(await pointersOf(attachmentId)).toHaveLength(0)
  })

  it('surfaces auth, rate-limit and server upload failures instead of falling back to inline bytes', async () => {
    for (const message of ['401 invalid api key', '429 rate limit exceeded', '500 internal server error']) {
      const a = await seedProvider(`files-${message}`, 'model-a', true)
      const attachmentId = await seedAttachment()
      const created = await installMock(streamingMock, () => ({
        specificationVersion: 'v4',
        provider: 'mock',
        uploadFile: async () => { throw new Error(message) },
      }))

      const c = await connect(await seedTestUser())
      c.ws.send(send({ parts: [{ type: 'text', text: 'look' }, { type: 'image', attachment_id: attachmentId }], provider_id: a, model_id: 'model-a' }))
      expect(await c.next('message.done')).toMatchObject({ status: 'error', error: expect.stringContaining(message) })
      // A failed upload is a failed turn: nothing was silently downgraded into inline bytes.
      expect(created).toHaveLength(0)
      expect(await pointersOf(attachmentId)).toHaveLength(0)
    }
  })
})

describe('generated image output', () => {
  const FINISH = STREAM.at(-1)!

  /** The stream every image test shares: some text first, then whatever the model emits as files. */
  function textThenFiles(files: StreamPart[], trailing: StreamPart[] = []): StreamPart[] {
    return [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'here it is' },
      { type: 'text-end', id: 't1' },
      ...files,
      ...trailing,
      FINISH,
    ]
  }

  const inlineChunk = (bytes: Uint8Array<ArrayBuffer>, mediaType = 'image/png'): StreamPart =>
    ({ type: 'file', mediaType, data: { type: 'data', data: bytes } })
  const base64Chunk = (bytes: Uint8Array<ArrayBuffer>, mediaType = 'image/png'): StreamPart =>
    ({ type: 'file', mediaType, data: { type: 'data', data: toBase64(bytes) } })

  const imageMock = (chunks: StreamPart[], chunkDelayInMs: number | null = null) => () => new MockLanguageModelV4({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: [...chunks], chunkDelayInMs, initialDelayInMs: null }) }),
  })

  function send(providerId: number, modelId: string): string {
    return JSON.stringify({ type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'draw a cat' }], provider_id: providerId, model_id: modelId })
  }

  const imageEventsOf = (c: WsHarness) => c.events.filter((e) => e.type === 'message.part' && e.part.type === 'image') as Array<{ part: { attachment_id: number } }>

  it('persists inline image bytes to R2 and gives every device only an attachment id', async () => {
    const bytes = uniqueImageBytes()
    const providerId = await seedProvider('img-inline', 'img-1', false, { modalities: { input: [], output: ['image'] } })
    await installMock(imageMock(textThenFiles([inlineChunk(bytes)])))

    const a = await connect(await seedTestUser())
    const b = await connect(await seedTestUser())
    a.ws.send(send(providerId, 'img-1'))
    expect(await a.next('message.done')).toMatchObject({ status: 'done' })
    await b.next('message.done')

    const imageEvent = a.events.find((e) => e.type === 'message.part' && e.part.type === 'image')!
    expect((imageEvent as { part: unknown }).part).toEqual({ type: 'image', attachment_id: expect.any(Number) })
    expect(JSON.stringify(imageEvent)).not.toContain('base64')
    expect(JSON.stringify(imageEvent)).not.toContain(toBase64(bytes))
    // Multi-device: the second socket received the very same frame, id and all.
    expect(b.events.find((e) => e.type === 'message.part' && e.part.type === 'image')).toEqual(imageEvent)

    const attachmentId = (imageEvent as { part: { attachment_id: number } }).part.attachment_id
    const saved = (await createDb(env.DB).query.attachments.findFirst({ where: eq(attachments.id, attachmentId) }))!
    expect(saved).toMatchObject({ origin: 'generated', mime: 'image/png', size: bytes.byteLength, sha256: await sha256(bytes) })
    const object = await env.BUCKET.get(saved.r2_key)
    expect(object).not.toBeNull()
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes)

    const rows = await listMessages(createDb(env.DB), conversationIdOf(a), 1)
    expect(untimed(rows[1]!.parts)).toEqual([
      { type: 'text', text: 'here it is' },
      { type: 'image', attachment_id: attachmentId },
    ])
    expect(JSON.stringify(rows[1]!.parts)).not.toContain('base64')
    expect(JSON.stringify(rows[1]!.parts)).not.toContain(toBase64(bytes))
  })

  it('decodes a base64 output and stores the decoded bytes', async () => {
    const bytes = uniqueImageBytes()
    const providerId = await seedProvider('img-b64', 'img-1', false, { modalities: { input: [], output: ['image'] } })
    await installMock(imageMock(textThenFiles([base64Chunk(bytes)])))

    const c = await connect(await seedTestUser())
    c.ws.send(send(providerId, 'img-1'))
    expect(await c.next('message.done')).toMatchObject({ status: 'done' })

    const saved = (await attachmentBySha(await sha256(bytes)))!
    expect(saved.origin).toBe('generated')
    expect(imageEventsOf(c).map((e) => e.part.attachment_id)).toEqual([saved.id])
    const object = await env.BUCKET.get(saved.r2_key)
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes)
  })

  it('downloads an HTTPS output from the stream and never lets the URL through', async () => {
    const bytes = uniqueImageBytes()
    const url = 'https://provider.example/tmp/stream.png'
    const providerId = await seedProvider('img-url', 'img-1', false, { modalities: { input: [], output: ['image'] } })
    const chunk: StreamPart = { type: 'file', mediaType: 'image/png', data: { type: 'url', url: new URL(url) } }
    await installMock(imageMock(textThenFiles([chunk])))
    vi.stubGlobal('fetch', async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }))

    try {
      const c = await connect(await seedTestUser())
      c.ws.send(send(providerId, 'img-1'))
      expect(await c.next('message.done')).toMatchObject({ status: 'done' })

      const saved = (await attachmentBySha(await sha256(bytes)))!
      expect(saved.origin).toBe('generated')
      expect(imageEventsOf(c).map((e) => e.part.attachment_id)).toEqual([saved.id])
      // The provider's temporary URL reaches neither the socket nor D1.
      expect(JSON.stringify(c.events)).not.toContain('provider.example')
      const rows = await listMessages(createDb(env.DB), conversationIdOf(c), 1)
      expect(untimed(rows[1]!.parts)).toEqual([
        { type: 'text', text: 'here it is' },
        { type: 'image', attachment_id: saved.id },
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reuses the existing attachment when the same bytes are emitted twice', async () => {
    const bytes = uniqueImageBytes()
    const digest = await sha256(bytes)
    const providerId = await seedProvider('img-dupe', 'img-1', false, { modalities: { input: [], output: ['image'] } })
    await installMock(imageMock(textThenFiles([inlineChunk(bytes), inlineChunk(bytes)])))

    const c = await connect(await seedTestUser())
    c.ws.send(send(providerId, 'img-1'))
    expect(await c.next('message.done')).toMatchObject({ status: 'done' })

    const ids = imageEventsOf(c).map((e) => e.part.attachment_id)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
    const rows = await createDb(env.DB).select().from(attachments).where(eq(attachments.sha256, digest))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.origin).toBe('generated')
    // Dedupe must never disturb the object the first write put there.
    expect(await env.BUCKET.head(rows[0]!.r2_key)).not.toBeNull()
  })

  it('fails the reply on an unsupported image type, keeping the text and persisting nothing', async () => {
    const bytes = uniqueImageBytes()
    const digest = await sha256(bytes)
    const providerId = await seedProvider('img-bad-mime', 'img-1', false, { modalities: { input: [], output: ['image'] } })
    await installMock(imageMock(textThenFiles([inlineChunk(bytes, 'image/svg+xml')])))

    const c = await connect(await seedTestUser())
    c.ws.send(send(providerId, 'img-1'))
    expect(await c.next('message.done')).toMatchObject({ status: 'error', error: expect.stringContaining('image/svg+xml') })

    expect(imageEventsOf(c)).toHaveLength(0)
    const rows = await listMessages(createDb(env.DB), conversationIdOf(c), 1)
    expect(rows[1]!.status).toBe('error')
    // Spec §9: the text already received survives, and no trace of the file is written anywhere.
    expect(untimed(rows[1]!.parts)).toEqual([{ type: 'text', text: 'here it is' }])
    expect(await attachmentBySha(digest)).toBeUndefined()
    expect(await env.BUCKET.head(r2Key(1, digest))).toBeNull()
  })

  it('does not resolve a generated image on any later turn', async () => {
    const bytes = uniqueImageBytes()
    const providerId = await seedProvider('img-history', 'img-1', false, { modalities: { input: [], output: ['image'] } })
    let turn = 0
    const created = await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: turn++ === 0 ? [...textThenFiles([inlineChunk(bytes)])] : [...STREAM],
          chunkDelayInMs: null, initialDelayInMs: null,
        }),
      }),
    }))

    const c = await connect(await seedTestUser())
    c.ws.send(send(providerId, 'img-1'))
    expect(await c.next('message.done')).toMatchObject({ status: 'done' })
    const conversationId = conversationIdOf(c)
    const generatedId = imageEventsOf(c)[0]!.part.attachment_id
    const saved = (await createDb(env.DB).query.attachments.findFirst({ where: eq(attachments.id, generatedId) }))!

    // `buildModelMessages` never replays a generated image, so the next turn has no reason to read
    // it: with the object gone, an assembler that still resolved it would fail the whole turn with
    // `attachment N bytes missing` over bytes nothing in the request wanted.
    await env.BUCKET.delete(saved.r2_key)

    c.events.length = 0
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: conversationId, parent_id: null, parts: [{ type: 'text', text: 'again' }],
      provider_id: providerId, model_id: 'img-1',
    }))
    expect(await c.next('message.done')).toMatchObject({ status: 'done' })
    // ...and the request it did send carries no file part at all.
    expect(filePartsOf(created[1]!)).toEqual([])
  })

  it('never writes file content into the DO inflight snapshot', async () => {
    const bytes = uniqueImageBytes()
    const providerId = await seedProvider('img-inflight', 'img-1', false, { modalities: { input: [], output: ['image'] } })
    const trailing: StreamPart[] = [
      { type: 'text-start', id: 't2' },
      { type: 'text-delta', id: 't2', delta: 'and more' },
      { type: 'text-end', id: 't2' },
    ]
    await installMock(imageMock(textThenFiles([inlineChunk(bytes)], trailing), 100))

    const c = await connect(await seedTestUser())
    c.ws.send(send(providerId, 'img-1'))
    // Wait for the persisted image part, not an earlier text or reasoning metadata frame.
    await nextImagePart(c)
    const snapshot = await inflightSnapshot()
    expect(snapshot).toContain('"attachment_id"')
    expect(snapshot).not.toContain('base64')
    expect(snapshot).not.toContain(toBase64(bytes))
    await c.next('message.done')
  })
})

describe('persistGeneratedImage', () => {
  let appPromise: Promise<Context> | undefined
  /** A real cordis root, so the R2 service and D1 under test are the production ones. */
  const app = () => (appPromise ??= createApp({ env, side: 'worker' }))

  async function hubLike(overrides: { db?: DB; assets?: Assets } = {}): Promise<Hub> {
    const ctx = await app()
    return { userId: 1, db: overrides.db ?? ctx.db.orm, app: { assets: overrides.assets ?? ctx.assets } } as unknown as Hub
  }

  const png = (bytes: Uint8Array<ArrayBuffer>, mediaType = 'image/png') => new DefaultGeneratedFile({ data: bytes, mediaType })

  /** Scoped to the one key those bytes would ever occupy: other test files share this bucket. */
  const storedObject = async (bytes: Uint8Array<ArrayBuffer>) =>
    env.BUCKET.head(r2Key(1, await sha256(bytes)))

  /**
   * A DB whose only altered behaviour is that `insert(...).values(...).returning()` runs `onInsert`
   * instead of writing — the shape a D1 failure takes at the drizzle boundary. Reads stay real, so
   * the recovery path sees whatever `onInsert` actually left behind.
   */
  function withFailingInsert(db: DB, onInsert: () => Promise<unknown>): DB {
    return new Proxy(db, {
      get(target, prop) {
        if (prop === 'insert') return () => ({ values: () => ({ returning: onInsert }) })
        const value = Reflect.get(target, prop) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    }) as DB
  }

  it('rejects an output that is not an accepted image type', async () => {
    const bytes = uniqueImageBytes()
    await expect(persistGeneratedImage(await hubLike(), png(bytes, 'application/pdf'))).rejects.toThrow(/application\/pdf/)
    expect(await attachmentBySha(await sha256(bytes))).toBeUndefined()
    expect(await storedObject(bytes)).toBeNull()
  })

  it('rejects a zero-byte output', async () => {
    const empty = new Uint8Array()
    await expect(persistGeneratedImage(await hubLike(), png(empty))).rejects.toThrow(/empty/)
    expect(await attachmentBySha(await sha256(empty))).toBeUndefined()
    expect(await storedObject(empty)).toBeNull()
  })

  it('rejects an output larger than the upload limit', async () => {
    const bytes = new Uint8Array(MAX_UPLOAD_BYTES + 1)
    await expect(persistGeneratedImage(await hubLike(), png(bytes))).rejects.toThrow(/too large/)
    expect(await attachmentBySha(await sha256(bytes))).toBeUndefined()
    expect(await storedObject(bytes)).toBeNull()
  })

  it('rejects an oversized inline output from its length, before copying the buffer', async () => {
    // A source that reports its length but holds no bytes: the guard has to run on the SDK buffer
    // itself, because a copy taken first would peak at twice the size inside the DO — and would
    // also read as empty here, failing with the wrong error.
    const source = { byteLength: MAX_UPLOAD_BYTES + 1 } as unknown as Uint8Array<ArrayBuffer>
    const file = { mediaType: 'image/png', base64: '', get uint8Array() { return source } } as unknown as GeneratedFile
    await expect(persistGeneratedImage(await hubLike(), file))
      .rejects.toThrow(`generated image too large: ${MAX_UPLOAD_BYTES + 1} bytes`)
  })

  it('rejects an oversized HTTPS output on content-length, without reading the body', async () => {
    // Buffering first would not fail one generation, it would OOM the `UserHub` DO and drop every
    // socket this user has, so the body must never be touched.
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0))
    const response = {
      ok: true,
      headers: new Headers({ 'content-type': 'image/png', 'content-length': String(MAX_UPLOAD_BYTES + 1) }),
      arrayBuffer,
    } as unknown as Response
    vi.stubGlobal('fetch', async () => response)
    try {
      await expect(persistGeneratedImage(await hubLike(), new DefaultGeneratedFile({ data: 'https://provider.example/huge.png', mediaType: 'image/png' })))
        .rejects.toThrow(`generated image too large: ${MAX_UPLOAD_BYTES + 1} bytes`)
      expect(arrayBuffer).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('accepts a download whose content-length is absent or unparseable', async () => {
    const bytes = uniqueImageBytes()
    // No early rejection is possible without a usable number, and that is not itself an error.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'image/png', 'content-length': 'chunked' }),
      arrayBuffer: async () => bytes.buffer,
    } as unknown as Response))
    try {
      const part = await persistGeneratedImage(await hubLike(), new DefaultGeneratedFile({ data: 'https://provider.example/ok.png', mediaType: 'image/png' }))
      expect(part).toEqual({ type: 'image', attachment_id: (await attachmentBySha(await sha256(bytes)))!.id })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('propagates an R2 write failure without leaving an attachment row', async () => {
    const bytes = uniqueImageBytes()
    const assets = { put: async () => { throw new Error('r2 unavailable') } } as unknown as Assets
    await expect(persistGeneratedImage(await hubLike({ assets }), png(bytes))).rejects.toThrow('r2 unavailable')
    expect(await attachmentBySha(await sha256(bytes))).toBeUndefined()
    expect(await storedObject(bytes)).toBeNull()
  })

  it('deletes the R2 object it wrote when the D1 insert fails', async () => {
    const bytes = uniqueImageBytes()
    const digest = await sha256(bytes)
    const ctx = await app()
    const db = withFailingInsert(ctx.db.orm, async () => { throw new Error('d1 insert failed') })
    await expect(persistGeneratedImage(await hubLike({ db }), png(bytes))).rejects.toThrow('d1 insert failed')
    // No orphaned row, and no half-written R2 pointer either.
    expect(await attachmentBySha(digest)).toBeUndefined()
    expect(await env.BUCKET.head(r2Key(1, digest))).toBeNull()
  })

  it('keeps the R2 object when a concurrent insert already claimed the same digest', async () => {
    const bytes = uniqueImageBytes()
    const digest = await sha256(bytes)
    const key = r2Key(1, digest)
    const ctx = await app()
    // Another writer wins the unique index while this insert is in flight: that row owns the key.
    const db = withFailingInsert(ctx.db.orm, async () => {
      await ctx.db.orm.insert(attachments).values({
        user_id: 1, sha256: digest, mime: 'image/png', size: bytes.byteLength,
        width: null, height: null, r2_key: key, origin: 'generated', created_at: 0,
      })
      throw new Error('UNIQUE constraint failed: attachments.sha256')
    })
    const part = await persistGeneratedImage(await hubLike({ db }), png(bytes))
    const owner = (await attachmentBySha(digest))!
    expect(part).toEqual({ type: 'image', attachment_id: owner.id })
    expect(await env.BUCKET.head(key)).not.toBeNull()
  })

  it('downloads an HTTPS output and persists what the download served', async () => {
    const bytes = uniqueImageBytes()
    const url = 'https://provider.example/tmp/out.png'
    const fetchSpy = vi.fn(async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchSpy)
    try {
      const part = await persistGeneratedImage(await hubLike(), new DefaultGeneratedFile({ data: url, mediaType: 'image/png' }))
      const row = (await attachmentBySha(await sha256(bytes)))!
      expect(part).toEqual({ type: 'image', attachment_id: row.id })
      expect(row.origin).toBe('generated')
      // The provider's temporary URL is never what gets stored.
      expect(JSON.stringify(row)).not.toContain('provider.example')
      const object = await env.BUCKET.get(row.r2_key)
      expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects an HTTPS output that fails to download or is not an image', async () => {
    vi.stubGlobal('fetch', async () => new Response('gone', { status: 404 }))
    try {
      await expect(persistGeneratedImage(await hubLike(), new DefaultGeneratedFile({ data: 'https://provider.example/gone.png', mediaType: 'image/png' })))
        .rejects.toThrow(/404/)
      vi.stubGlobal('fetch', async () => new Response('<html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }))
      await expect(persistGeneratedImage(await hubLike(), new DefaultGeneratedFile({ data: 'https://provider.example/page.html', mediaType: 'image/png' })))
        .rejects.toThrow(/text\/html/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

/**
 * One chat exercised across every feature this round added at once. The unit and per-feature suites
 * already prove each mechanism on its own; what is only observable here is how they compose —
 * inheritance choosing the provider that a file pointer then gets scoped to, a generated image
 * reaching a reconnecting device as an id, and a Project disappearing underneath a live chat.
 */
describe('cross-feature integration', () => {
  /** Distinct bytes per call: D1 and R2 are shared across this project's tests and dedupe by digest. */
  let uploadSeq = 0
  const uniqueUploadBytes = (): Uint8Array<ArrayBuffer> =>
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...new TextEncoder().encode(`uploaded-${++uploadSeq}`)])

  /** A user upload as the REST route would leave it: bytes in R2 under the key its own digest dictates. */
  async function seedUpload(bytes: Uint8Array<ArrayBuffer>): Promise<number> {
    const db = createDb(env.DB)
    await seedTestUser(db)
    const digest = await sha256(bytes)
    const key = r2Key(1, digest)
    await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: 'image/png' } })
    const [row] = await db.insert(attachments).values({
      user_id: 1, sha256: digest, mime: 'image/png', size: bytes.byteLength,
      width: 1, height: 1, r2_key: key, origin: 'upload', created_at: 0,
    }).returning()
    return row!.id
  }

  it('carries one Project chat through Auto reasoning, an uploaded image, an A → B → A switch, a generated image, a reconnect and Project deletion', async () => {
    const db = createDb(env.DB)
    const providerA = await seedProvider('int-a', 'int-a-1', true, { reasoning: true, modalities: { input: [], output: ['image'] } })
    const providerB = await seedProvider('int-b', 'int-b-1', true, { reasoning: true })
    const commandProvider = await seedProvider('int-cmd', 'int-cmd-1', true, { reasoning: true })
    const projectId = await seedProject({
      system_prompt: 'PROJECT', provider_id: providerA, model_id: 'int-a-1',
      params: { temperature: 0.25, max_tokens: 32, reasoning_effort: 'high' },
    })
    const uploadBytes = uniqueUploadBytes()
    const uploadId = await seedUpload(uploadBytes)
    const generatedBytes = uniqueImageBytes()
    const generatedUrl = 'https://provider.example/tmp/integration.png'

    // The first turn draws; the later two only talk, so the image travels as history from then on.
    const drawing: StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'here it is' },
      { type: 'text-end', id: 't1' },
      { type: 'file', mediaType: 'image/png', data: { type: 'url', url: new URL(generatedUrl) } },
      { type: 'text-start', id: 't2' },
      { type: 'text-delta', id: 't2', delta: ' and more' },
      { type: 'text-end', id: 't2' },
      STREAM.at(-1)!,
    ]
    const uploads: Upload[] = []
    let turn = 0
    const created = await installMock(() => {
      const first = turn++ === 0
      return new MockLanguageModelV4({
        // Only the drawing turn is slowed, so a device can rejoin while it is still streaming.
        doStream: async () => ({
          stream: simulateReadableStream({ chunks: [...(first ? drawing : STREAM)], chunkDelayInMs: first ? 150 : null, initialDelayInMs: null }),
        }),
      })
    }, recordingFiles(uploads))

    // The provider only ever answers with a link; the bytes exist nowhere but behind it and in R2.
    vi.stubGlobal('fetch', async () => new Response(generatedBytes, { headers: { 'content-type': 'image/png' } }))
    try {
      // ---- turn 1: the draft creates the conversation, the Project supplies prompt, model and params
      const c = await connect(await seedTestUser())
      c.ws.send(JSON.stringify(sendCommandFor({
        conversationId: null, parentId: null,
        parts: [{ type: 'text', text: 'draw from this' }, { type: 'image', attachment_id: uploadId }],
        // The Composer's own selection is the last fallback, so the Project default must outrank it.
        model: { provider_id: commandProvider, model_id: 'int-cmd-1' },
        draft: { project_id: projectId, system_prompt: 'CONVERSATION', model: null, params: { reasoning_enabled: true, reasoning_effort: null } },
      })))

      const imageEvent = await nextImagePart(c)
      const generatedId = (imageEvent as { part: { attachment_id: number } }).part.attachment_id
      expect((imageEvent as { part: unknown }).part).toEqual({ type: 'image', attachment_id: generatedId })

      // A device joining mid-generation is handed the same reduced part, never the provider's link.
      const rejoin = await connect(await seedTestUser())
      const snapshot = await rejoin.next('snapshot')
      const inflight = (snapshot as { inflight: Array<{ parts: Part[] }> }).inflight
      const live = inflight.find((m) => m.parts.some((p) => p.type === 'image' && p.attachment_id === generatedId))
      expect(live).toBeDefined()
      expect(JSON.stringify(inflight)).not.toContain('provider.example')
      expect(JSON.stringify(inflight)).not.toContain(toBase64(generatedBytes))

      // ...and so is the DO storage that snapshot was rebuilt from.
      const stored = await inflightSnapshot()
      expect(stored).toContain(`"attachment_id":${generatedId}`)
      expect(stored).not.toContain('provider.example')
      expect(stored).not.toContain(toBase64(generatedBytes))

      expect(await c.next('message.done')).toMatchObject({ status: 'done' })
      const conversationId = conversationIdOf(c)

      const conversation = (await getConversation(db, conversationId, 1))!
      expect(conversation).toMatchObject({ project_id: projectId, system_prompt: 'CONVERSATION', provider_id: null, model_id: null })
      // Explicit Auto is a present key holding `null`, not an absent (inherited) one — through D1.
      expect(conversation.params).toEqual({ reasoning_enabled: true, reasoning_effort: null })
      expect('reasoning_effort' in conversation.params!).toBe(true)

      const firstCall = created[0]!.doStreamCalls[0]!
      expect(firstCall.prompt[0]).toMatchObject({ role: 'system', content: 'PROJECT\n\nCONVERSATION' })
      expect(firstCall).toMatchObject({ temperature: 0.25, maxOutputTokens: 32 })
      const reference = (providerId: number, n: number) =>
        ({ type: 'file', mediaType: 'image/png', data: { type: 'reference', reference: { mock: `file-${providerId}-${n}` } } })
      expect(filePartsOf(created[0]!)).toEqual([reference(providerA, 1)])

      const turn1 = await listMessages(db, conversationId, 1)
      // The Project default won over the command model, and was recorded on the reply.
      expect(turn1[1]).toMatchObject({ provider_id: providerA, model_id: 'int-a-1' })
      expect(untimed(turn1[1]!.parts)).toEqual([
        { type: 'text', text: 'here it is' },
        { type: 'image', attachment_id: generatedId },
        { type: 'text', text: ' and more' },
      ])

      const generated = (await db.query.attachments.findFirst({ where: eq(attachments.id, generatedId) }))!
      expect(generated).toMatchObject({ origin: 'generated', mime: 'image/png', sha256: await sha256(generatedBytes) })
      const object = await env.BUCKET.get(generated.r2_key)
      expect(new Uint8Array(await object!.arrayBuffer())).toEqual(generatedBytes)

      // ---- turn 2: the user pins this chat to provider B, which knows nothing of A's file id
      c.events.length = 0
      c.ws.send(JSON.stringify({ type: 'conversation.update', conversation_id: conversationId, provider_id: providerB, model_id: 'int-b-1' }))
      expect(await c.next('conversation.updated')).toMatchObject({ conversation: { id: conversationId, provider_id: providerB, model_id: 'int-b-1' } })

      c.events.length = 0
      c.ws.send(JSON.stringify({
        type: 'send', conversation_id: conversationId, parent_id: null, parts: [{ type: 'text', text: 'again' }],
        provider_id: commandProvider, model_id: 'int-cmd-1',
      }))
      expect(await c.next('message.done')).toMatchObject({ status: 'done' })
      expect(filePartsOf(created[1]!)).toEqual([reference(providerB, 1)])

      // ---- turn 3: back to A, whose original pointer is still valid
      c.events.length = 0
      c.ws.send(JSON.stringify({ type: 'conversation.update', conversation_id: conversationId, provider_id: providerA, model_id: 'int-a-1' }))
      await c.next('conversation.updated')
      c.events.length = 0
      c.ws.send(JSON.stringify({
        type: 'send', conversation_id: conversationId, parent_id: null, parts: [{ type: 'text', text: 'once more' }],
        provider_id: commandProvider, model_id: 'int-cmd-1',
      }))
      expect(await c.next('message.done')).toMatchObject({ status: 'done' })
      expect(filePartsOf(created[2]!)).toEqual([reference(providerA, 1)])

      // The pointer is scoped to (attachment, provider) and to nothing else: no conversation, no model.
      // Asserted on the whole recorded list rather than a filtered slice: the generated image is
      // never replayed to the model, so it must never be read out of R2 or shipped to a provider's
      // Files API either, and only "exactly these uploads happened" can say so.
      expect(uploads.map((u) => [u.providerId, u.options.filename])).toEqual([
        [providerA, `attachment-${uploadId}.png`],
        [providerB, `attachment-${uploadId}.png`],
      ])
      expect(await pointersOf(generatedId)).toEqual([])
      const pointers = await pointersOf(uploadId)
      expect(pointers.map((r) => r.provider_id).sort((x, y) => x - y)).toEqual([providerA, providerB].sort((x, y) => x - y))
      expect(pointers[0]).not.toHaveProperty('api_key')

      // Nothing in this chat's persisted history is bytes, base64 or a provider URL.
      const history = await listMessages(db, conversationId, 1)
      const json = JSON.stringify(history.map((r) => r.parts))
      expect(json).not.toContain('provider.example')
      expect(json).not.toContain('base64')
      expect(json).not.toContain(toBase64(generatedBytes))
      expect(json).not.toContain(toBase64(uploadBytes))

      // ---- deleting the Project releases the chat instead of destroying it
      c.events.length = 0
      c.ws.send(JSON.stringify({ type: 'project.delete', project_id: projectId }))
      expect(await c.next('project.deleted')).toEqual({ type: 'project.deleted', project_id: projectId })
      expect(await c.next('conversation.updated')).toMatchObject({ conversation: { id: conversationId, project_id: null } })

      const released = (await getConversation(db, conversationId, 1))!
      expect(released.project_id).toBeNull()
      // Its own override, its history and its media all outlive the Project that framed them.
      expect(released).toMatchObject({ provider_id: providerA, model_id: 'int-a-1', system_prompt: 'CONVERSATION' })
      expect(await listMessages(db, conversationId, 1)).toHaveLength(history.length)
      expect(await env.BUCKET.head(generated.r2_key)).not.toBeNull()
      expect(await db.query.attachments.findFirst({ where: eq(attachments.id, generatedId) })).toBeDefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the three reasoning states apart across a D1 round trip', async () => {
    const db = createDb(env.DB)
    await seedTestUser(db)
    const projectId = await seedProject({ params: { reasoning_enabled: true, reasoning_effort: 'medium' } })
    const project = (await getProject(db, projectId, 1))!

    // Absent means inherit, `null` means explicit Auto, a string means an explicit strength. The
    // distinction lives in a JSON column, so only a real write and read back can prove it survives.
    const cases: Array<{ params: ConversationParams; key: boolean; effort: string | null }> = [
      { params: { reasoning_effort: 'high' }, key: true, effort: 'high' },
      { params: { reasoning_enabled: true, reasoning_effort: null }, key: true, effort: null },
      { params: { temperature: 0.2 }, key: false, effort: 'medium' },
    ]
    for (const { params, key, effort } of cases) {
      const created = await createConversation(db, {
        user_id: 1, title: 'r', project_id: projectId, provider_id: null, model_id: null, params,
      })
      const stored = (await getConversation(db, created.id, 1))!
      expect('reasoning_effort' in (stored.params ?? {})).toBe(key)
      expect(resolveEffectiveConfig({ conversation: stored, project }).params.reasoning_effort).toBe(effort)
    }
  })
})
