import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import type { FilesV4, FilesV4UploadFileCallOptions } from '@ai-sdk/provider'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { createDb } from '@/server/db/client'
import { ensureDefaultUser } from '@/server/plugins/database'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import { buildModelMessages } from '@/server/plugins/llm/messages'
import { createSession, getSession, insertMessage, listMessages, toMessage } from '@/server/plugins/hub/sessions'
import { attachmentProviderFiles, attachments, models, projects, providers, users } from '@/server/db/schema'
import type { ProviderRow } from '@/server/db/schema'
import { DEFAULT_USER_ID } from '@/shared/constants'
import type { Message } from '@/shared/models'
import type { Part } from '@/shared/parts'
import type { UserHub } from '@/server/index'
import { connect } from './ws-helper'

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

async function seedProvider(name = 'mock', modelId = 'mock-1', nativeFiles = false): Promise<number> {
  const db = createDb(env.DB)
  await ensureDefaultUser(db)
  const [p] = await db.insert(providers).values({
    user_id: DEFAULT_USER_ID, name, protocol: 'mock' as never, base_url: 'https://mock',
    api_key: await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'k'), extra: null, enabled: true,
    native_files: nativeFiles, created_at: 0,
  }).returning()
  await db.insert(models).values({ provider_id: p!.id, model_id: modelId, display_name: 'Mock', capabilities: { reasoning: true }, pricing: null, enabled: true, sort: 0 })
  return p!.id
}

async function seedProject(input: Partial<typeof projects.$inferInsert> = {}): Promise<number> {
  const db = createDb(env.DB)
  const [row] = await db.insert(projects).values({
    user_id: DEFAULT_USER_ID, name: 'P', system_prompt: null, provider_id: null, model_id: null,
    params: null, created_at: 0, updated_at: 0, ...input,
  }).returning()
  return row!.id
}

async function installMock(
  mockFactory: () => MockLanguageModelV4,
  createFiles?: (provider: ProviderRow, apiKey: string) => FilesV4,
): Promise<MockLanguageModelV4[]> {
  const created: MockLanguageModelV4[] = []
  const stub = env.USER_HUB.getByName(String(DEFAULT_USER_ID))
  await runInDurableObject(stub, async (instance: UserHub) => {
    await instance.app.plugin({
      name: 'mock-protocol',
      inject: ['llm'],
      apply(c) {
        c.llm.register('mock', {
          createModel: () => { const m = mockFactory(); created.push(m); return m as never },
          ...(createFiles ? { createFiles } : {}),
        })
      },
    })
  })
  return created
}

describe('generation', () => {
  it('streams a reply to every socket and persists it', async () => {
    const providerId = await seedProvider()
    const created = await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: [...STREAM], chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const a = await connect()
    const b = await connect()
    a.ws.send(JSON.stringify({ type: 'send', request_id: 'r1', session_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi there' }], provider_id: providerId, model_id: 'mock-1' }))
    const done = await a.next('message.done')
    expect(done).toMatchObject({ type: 'message.done', status: 'done', usage: { prompt: 10, completion: 5, cached: 2, reasoning: 2 }, error: null })

    const types = a.events.map((e) => e.type)
    expect(types.slice(0, 5)).toEqual(['snapshot', 'session.created', 'message.created', 'message.created', 'head.changed'])
    expect(types.filter((t) => t === 'message.delta')).toHaveLength(3)
    await b.next('message.done')
    expect(b.events.filter((e) => e.type === 'message.delta')).toEqual(a.events.filter((e) => e.type === 'message.delta'))

    const created1 = a.events.find((e) => e.type === 'session.created')!
    const sessionId = (created1 as { session: { id: number; title: string } }).session.id
    expect((created1 as { session: { title: string } }).session.title).toBe('hi there')
    const rows = await listMessages(createDb(env.DB), sessionId)
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant'])
    expect(rows[1]!.parts).toEqual([
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
    const c = await connect()
    c.ws.send(JSON.stringify({ type: 'send', session_id: null, parent_id: null, parts: [{ type: 'text', text: 'q' }], provider_id: providerId, model_id: 'mock-1' }))
    await c.next('message.done')
    const firstAssistant = (c.events.filter((e) => e.type === 'message.created')[1] as { message: { id: number; session_id: number; parent_id: number } }).message
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
    const c = await connect()
    c.ws.send(JSON.stringify({ type: 'send', session_id: null, parent_id: null, parts: [{ type: 'text', text: 'slow' }], provider_id: providerId, model_id: 'mock-1' }))
    await c.next('message.delta')
    const sessionId = (c.events.find((e) => e.type === 'session.created') as { session: { id: number } }).session.id
    c.ws.send(JSON.stringify({ type: 'stop', session_id: sessionId }))
    const done = await c.next('message.done')
    // An aborted stream never emits `finish`, so usage is genuinely unknown rather than zero.
    expect(done).toMatchObject({ status: 'aborted', usage: null })
    const rows = await listMessages(createDb(env.DB), sessionId)
    expect(rows[1]!.status).toBe('aborted')
    // The delta we waited for is already accumulated, so the partial content must survive the abort.
    expect(rows[1]!.parts.length).toBeGreaterThan(0)
  })

  it('reports provider errors as status error', async () => {
    const providerId = await seedProvider()
    await installMock(() => new MockLanguageModelV4({ doStream: async () => { throw new Error('boom 401') } }))
    const c = await connect()
    c.ws.send(JSON.stringify({ type: 'send', session_id: null, parent_id: null, parts: [{ type: 'text', text: 'x' }], provider_id: providerId, model_id: 'mock-1' }))
    const done = await c.next('message.done')
    expect(done).toMatchObject({ status: 'error', error: expect.stringContaining('boom 401') })
  })
})

describe('project inheritance', () => {
  /** A fresh mock that always returns the canned stream, so calls can be inspected afterwards. */
  const streamingMock = () => new MockLanguageModelV4({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: [...STREAM], chunkDelayInMs: null, initialDelayInMs: null }) }),
  })

  it('inherits the Project prompt, model and params without copying them into the session', async () => {
    const projectProvider = await seedProvider('project-provider', 'model-a')
    const commandProvider = await seedProvider('command-provider', 'model-b')
    const projectId = await seedProject({
      system_prompt: 'PROJECT', provider_id: projectProvider, model_id: 'model-a',
      params: { temperature: 0.5, max_tokens: 64, reasoning_effort: 'high' },
    })
    const created = await installMock(streamingMock)
    const c = await connect()
    c.ws.send(JSON.stringify({
      type: 'send', session_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
      // The command's model is the last fallback; the Project default must win over it.
      provider_id: commandProvider, model_id: 'model-b',
      project_id: projectId, system_prompt: 'SESSION', params: { top_p: 0.25, temperature: 0 },
    }))
    expect(await c.next('message.done')).toMatchObject({ status: 'done' })

    const call = created[0]!.doStreamCalls[0]!
    expect(call.prompt[0]).toMatchObject({ role: 'system', content: 'PROJECT\n\nSESSION' })
    // temperature: 0 is a real session override, not an absent value.
    expect(call).toMatchObject({ temperature: 0, topP: 0.25, maxOutputTokens: 64 })

    const sessionId = (c.events.find((e) => e.type === 'session.created') as { session: { id: number } }).session.id
    const row = (await getSession(createDb(env.DB), sessionId))!
    expect(row.project_id).toBe(projectId)
    expect(row.system_prompt).toBe('SESSION')
    expect(row.params).toEqual({ top_p: 0.25, temperature: 0 })
    // Inherited values are never copied down, and the generation-time model is never persisted.
    expect(row.provider_id).toBeNull()
    expect(row.model_id).toBeNull()

    const rows = await listMessages(createDb(env.DB), sessionId)
    expect(rows[1]).toMatchObject({ provider_id: projectProvider, model_id: 'model-a' })
  })

  it('prefers the session override over the Project default and persists it', async () => {
    const projectProvider = await seedProvider('project-provider', 'model-a')
    const sessionProvider = await seedProvider('session-provider', 'model-b')
    const projectId = await seedProject({ provider_id: projectProvider, model_id: 'model-a' })
    await installMock(streamingMock)
    const c = await connect()
    c.ws.send(JSON.stringify({
      type: 'send', session_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
      provider_id: projectProvider, model_id: 'model-a',
      project_id: projectId, session_provider_id: sessionProvider, session_model_id: 'model-b',
    }))
    await c.next('message.done')

    const sessionId = (c.events.find((e) => e.type === 'session.created') as { session: { id: number } }).session.id
    const row = (await getSession(createDb(env.DB), sessionId))!
    expect(row).toMatchObject({ provider_id: sessionProvider, model_id: 'model-b' })
    const rows = await listMessages(createDb(env.DB), sessionId)
    expect(rows[1]).toMatchObject({ provider_id: sessionProvider, model_id: 'model-b' })
  })

  it('picks up a Project edit on the next generation of an existing session', async () => {
    const providerId = await seedProvider()
    const projectId = await seedProject({ system_prompt: 'FIRST' })
    const created = await installMock(streamingMock)
    const c = await connect()
    c.ws.send(JSON.stringify({
      type: 'send', session_id: null, parent_id: null, parts: [{ type: 'text', text: 'a' }],
      provider_id: providerId, model_id: 'mock-1', project_id: projectId,
    }))
    await c.next('message.done')
    const sessionId = (c.events.find((e) => e.type === 'session.created') as { session: { id: number } }).session.id

    await createDb(env.DB).update(projects).set({ system_prompt: 'SECOND' }).where(eq(projects.id, projectId))
    c.ws.send(JSON.stringify({
      type: 'send', session_id: sessionId, parent_id: null, parts: [{ type: 'text', text: 'b' }],
      provider_id: providerId, model_id: 'mock-1',
    }))
    await c.nextAfter('message.done', 2)
    expect(created[0]!.doStreamCalls[0]!.prompt[0]).toMatchObject({ content: 'FIRST' })
    expect(created[1]!.doStreamCalls[0]!.prompt[0]).toMatchObject({ content: 'SECOND' })
  })

  it('lets an explicit regenerate model outrank the session override and the Project default', async () => {
    const projectProvider = await seedProvider('project-provider', 'model-a')
    const sessionProvider = await seedProvider('session-provider', 'model-b')
    const pickedProvider = await seedProvider('picked-provider', 'model-c')
    const projectId = await seedProject({ system_prompt: 'PROJECT', provider_id: projectProvider, model_id: 'model-a', params: { temperature: 0.4 } })
    const created = await installMock(streamingMock)
    const c = await connect()
    c.ws.send(JSON.stringify({
      type: 'send', session_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
      provider_id: projectProvider, model_id: 'model-a',
      project_id: projectId, session_provider_id: sessionProvider, session_model_id: 'model-b',
    }))
    await c.next('message.done')
    const first = (c.events.filter((e) => e.type === 'message.created')[1] as { message: { id: number; session_id: number } }).message

    c.ws.send(JSON.stringify({ type: 'regenerate', message_id: first.id, provider_id: pickedProvider, model_id: 'model-c' }))
    await c.nextAfter('message.done', 2)

    const rows = await listMessages(createDb(env.DB), first.session_id)
    expect(rows[1]).toMatchObject({ provider_id: sessionProvider, model_id: 'model-b' })
    // The one-shot choice wins outright — it is not the lowest fallback layer.
    expect(rows[2]).toMatchObject({ provider_id: pickedProvider, model_id: 'model-c' })
    // ...and it is never persisted onto the session, which keeps its own override.
    expect(await getSession(createDb(env.DB), first.session_id)).toMatchObject({ provider_id: sessionProvider, model_id: 'model-b' })
    // Prompt and params still inherit from the Project on the regenerated turn.
    expect(created[1]!.doStreamCalls[0]!.prompt[0]).toMatchObject({ role: 'system', content: 'PROJECT' })
    expect(created[1]!.doStreamCalls[0]).toMatchObject({ temperature: 0.4 })
  })

  it('rejects an unavailable inherited model, naming the layer it came from', async () => {
    const db = createDb(env.DB)
    const projectProvider = await seedProvider('project-provider', 'model-a')
    const commandProvider = await seedProvider('command-provider', 'model-b')
    const projectId = await seedProject({ provider_id: projectProvider, model_id: 'model-a' })
    await db.update(models).set({ enabled: false }).where(eq(models.provider_id, projectProvider))
    await installMock(streamingMock)

    const c = await connect()
    c.ws.send(JSON.stringify({
      type: 'send', request_id: 'p1', session_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
      provider_id: commandProvider, model_id: 'model-b', project_id: projectId,
    }))
    expect(await c.next('error')).toMatchObject({ request_id: 'p1', message: '模型不可用（来源：Project）' })
    // No half-made session and no orphan message may survive a rejected generation.
    expect(c.events.some((e) => e.type === 'session.created' || e.type === 'message.created')).toBe(false)

    c.ws.send(JSON.stringify({
      type: 'send', request_id: 's1', session_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
      provider_id: commandProvider, model_id: 'model-b',
      session_provider_id: projectProvider, session_model_id: 'model-a',
    }))
    expect(await c.nextAfter('error', 2)).toMatchObject({ request_id: 's1', message: '模型不可用（来源：会话）' })
  })

  it('rejects a Project owned by another user', async () => {
    const db = createDb(env.DB)
    const providerId = await seedProvider()
    const [other] = await db.insert(users).values({ name: 'other', settings: { plugins: {} }, created_at: 0 }).returning()
    const projectId = await seedProject({ user_id: other!.id })
    await installMock(streamingMock)
    const c = await connect()
    c.ws.send(JSON.stringify({
      type: 'send', request_id: 'x1', session_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
      provider_id: providerId, model_id: 'mock-1', project_id: projectId,
    }))
    expect(await c.next('error')).toMatchObject({ request_id: 'x1', message: 'project not found' })
    expect(c.events.some((e) => e.type === 'session.created')).toBe(false)
  })

  it('rejects session-init fields sent alongside an existing session_id', async () => {
    const providerId = await seedProvider()
    await installMock(streamingMock)
    const c = await connect()
    c.ws.send(JSON.stringify({
      type: 'send', session_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
      provider_id: providerId, model_id: 'mock-1',
    }))
    await c.next('message.done')
    const sessionId = (c.events.find((e) => e.type === 'session.created') as { session: { id: number } }).session.id

    c.ws.send(JSON.stringify({
      type: 'send', request_id: 'i1', session_id: sessionId, parent_id: null, parts: [{ type: 'text', text: 'again' }],
      provider_id: providerId, model_id: 'mock-1', system_prompt: 'ignored',
    }))
    const err = await c.next('error')
    expect(err).toMatchObject({ request_id: 'i1' })
    expect((err as { message: string }).message).toContain('session init fields')
    // The rejected command must not have persisted anything.
    expect(await listMessages(createDb(env.DB), sessionId)).toHaveLength(2)
  })
})

describe('provider metadata round trip', () => {
  /** OpenAI Responses shape: no visible summary, but an item id and encrypted content to replay. */
  const META_STREAM: StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: 'r', modelId: 'mock', timestamp: new Date(0) },
    { type: 'reasoning-start', id: 'r1', providerMetadata: { openai: { itemId: 'rs_1' } } },
    { type: 'reasoning-end', id: 'r1', providerMetadata: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'ENC' } } },
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
    const c = await connect()
    c.ws.send(JSON.stringify({ type: 'send', session_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }], provider_id: providerId, model_id: 'mock-1' }))
    await c.next('message.done')
    const sessionId = (c.events.find((e) => e.type === 'session.created') as { session: { id: number } }).session.id

    const stored: Part[] = [
      { type: 'reasoning', text: '', providerOptions: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'ENC' } } },
      { type: 'text', text: 'Hello', providerOptions: { google: { thoughtSignature: 'TS_TEXT' } } },
    ]
    // An empty summary is not an absent round trip: the encrypted item still has to reach D1.
    expect((await listMessages(createDb(env.DB), sessionId))[1]!.parts).toEqual(stored)

    c.ws.send(JSON.stringify({ type: 'send', session_id: sessionId, parent_id: null, parts: [{ type: 'text', text: 'more' }], provider_id: providerId, model_id: 'mock-1' }))
    await c.nextAfter('message.done', 2)
    const prompt = created[1]!.doStreamCalls[0]!.prompt
    expect(prompt.find((m) => m.role === 'assistant')!.content).toEqual([
      { type: 'reasoning', text: '', providerOptions: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'ENC' } } },
      { type: 'text', text: 'Hello', providerOptions: { google: { thoughtSignature: 'TS_TEXT' } } },
    ])
  })

  it('rebuilds identical model messages from memory and from D1 JSON', async () => {
    const db = createDb(env.DB)
    await ensureDefaultUser(db)
    const session = await createSession(db, { user_id: DEFAULT_USER_ID, title: 't', provider_id: null, model_id: null })
    const userParts: Part[] = [{ type: 'text', text: 'q' }]
    const assistantParts: Part[] = [
      { type: 'reasoning', text: 'hmm', providerOptions: { anthropic: { signature: 'SIG', redactedData: 'RED' } } },
      { type: 'text', text: 'a cat', providerOptions: { google: { thoughtSignature: 'TS_TEXT' } } },
      { type: 'tool_call', id: 'call_1', name: 'lookup', args: { q: 'cat' }, providerOptions: { google: { thoughtSignature: 'TS_TOOL' } } },
      { type: 'tool_result', call_id: 'call_1', name: 'lookup', content: { ok: true } },
    ]
    const base = { session_id: session.id, provider_id: null, model_id: null, usage: null, status: 'done' as const, error: null, created_at: 0 }
    const user = await insertMessage(db, { ...base, parent_id: null, seq: 0, role: 'user', parts: userParts })
    const assistant = await insertMessage(db, { ...base, parent_id: user.id, seq: 1, role: 'assistant', parts: assistantParts })

    // The literals never left memory; the rows came back out of the D1 JSON column.
    const inMemory: Message[] = [{ ...toMessage(user), parts: userParts }, { ...toMessage(assistant), parts: assistantParts }]
    const fromD1 = (await listMessages(db, session.id)).map((r) => toMessage(r))
    expect(fromD1).toEqual(inMemory)
    for (const protocol of ['openai-completions', 'openai-responses', 'anthropic', 'vertex'] as const) {
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
    await ensureDefaultUser(db)
    const key = `${DEFAULT_USER_ID}/${digest.slice(0, 2)}/${digest}`
    await env.BUCKET.put(key, PNG, { httpMetadata: { contentType: 'image/png' } })
    const [row] = await db.insert(attachments).values({
      user_id: DEFAULT_USER_ID, sha256: digest, mime: 'image/png', size: PNG.byteLength,
      width: 1, height: 1, r2_key: key, origin: 'upload', created_at: 0,
    }).returning()
    return row!.id
  }

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

  /** Every file part the adapter actually received, across all roles of one call's prompt. */
  function filePartsOf(model: MockLanguageModelV4): Array<{ type: string; mediaType: string; data: unknown }> {
    const parts = model.doStreamCalls[0]!.prompt.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string }>) : []))
    return parts.filter((p) => p.type === 'file') as Array<{ type: string; mediaType: string; data: unknown }>
  }

  const pointersOf = (attachmentId: number) =>
    createDb(env.DB).select().from(attachmentProviderFiles).where(eq(attachmentProviderFiles.attachment_id, attachmentId))

  function send(body: Record<string, unknown>): string {
    return JSON.stringify({ type: 'send', session_id: null, parent_id: null, ...body })
  }

  it('uploads once per provider and reuses the first pointer when the session switches back', async () => {
    const a = await seedProvider('files-a', 'model-a', true)
    const b = await seedProvider('files-b', 'model-b', true)
    const attachmentId = await seedAttachment()
    const uploads: Upload[] = []
    const created = await installMock(streamingMock, recordingFiles(uploads))

    const c = await connect()
    c.ws.send(send({ parts: [{ type: 'text', text: 'look' }, { type: 'image', attachment_id: attachmentId }], provider_id: a, model_id: 'model-a' }))
    await c.next('message.done')
    const sessionId = (c.events.find((e) => e.type === 'session.created') as { session: { id: number } }).session.id

    // Same image, now travelling to a different provider: A's id means nothing to B.
    c.ws.send(send({ session_id: sessionId, parts: [{ type: 'text', text: 'again' }], provider_id: b, model_id: 'model-b' }))
    await c.nextAfter('message.done', 2)

    // ...and back to A, whose original pointer is still valid.
    c.ws.send(send({ session_id: sessionId, parts: [{ type: 'text', text: 'once more' }], provider_id: a, model_id: 'model-a' }))
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

  it('re-uploads when the stored pointer has expired, replacing the row', async () => {
    const a = await seedProvider('files-a', 'model-a', true)
    const attachmentId = await seedAttachment()
    const uploads: Upload[] = []
    const created = await installMock(streamingMock, recordingFiles(uploads))

    const c = await connect()
    c.ws.send(send({ parts: [{ type: 'text', text: 'look' }, { type: 'image', attachment_id: attachmentId }], provider_id: a, model_id: 'model-a' }))
    await c.next('message.done')
    const sessionId = (c.events.find((e) => e.type === 'session.created') as { session: { id: number } }).session.id

    // An expired pointer must never take part in context assembly, cleanup job or not.
    await createDb(env.DB).update(attachmentProviderFiles).set({ expires_at: Date.now() - 1 })
      .where(eq(attachmentProviderFiles.attachment_id, attachmentId))

    c.ws.send(send({ session_id: sessionId, parts: [{ type: 'text', text: 'again' }], provider_id: a, model_id: 'model-a' }))
    await c.nextAfter('message.done', 2)

    expect(uploads.map((u) => u.providerId)).toEqual([a, a])
    expect(filePartsOf(created[1]!)).toEqual([
      { type: 'file', mediaType: 'image/png', data: { type: 'reference', reference: { mock: `file-${a}-2` } } },
    ])
    const rows = await pointersOf(attachmentId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.provider_reference).toEqual({ mock: `file-${a}-2` })
    expect(rows[0]!.expires_at).toBeGreaterThan(Date.now())
  })

  it('persists the provider-reported expiry, and otherwise the requested seven days', async () => {
    const reported = new Date(Date.now() + 3_600_000)
    const a = await seedProvider('files-a', 'model-a', true)
    const b = await seedProvider('files-b', 'model-b', true)
    const attachmentId = await seedAttachment()
    await installMock(streamingMock, (provider) => recordingFiles([], provider.id === a ? reported : undefined)(provider))

    const c = await connect()
    c.ws.send(send({ parts: [{ type: 'text', text: 'look' }, { type: 'image', attachment_id: attachmentId }], provider_id: a, model_id: 'model-a' }))
    await c.next('message.done')
    const sessionId = (c.events.find((e) => e.type === 'session.created') as { session: { id: number } }).session.id
    const before = Date.now()
    c.ws.send(send({ session_id: sessionId, parts: [{ type: 'text', text: 'again' }], provider_id: b, model_id: 'model-b' }))
    await c.nextAfter('message.done', 2)

    const rows = await pointersOf(attachmentId)
    expect(rows.find((r) => r.provider_id === a)!.expires_at).toBe(reported.getTime())
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

    const c = await connect()
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

      const c = await connect()
      c.ws.send(send({ parts: [{ type: 'text', text: 'look' }, { type: 'image', attachment_id: attachmentId }], provider_id: a, model_id: 'model-a' }))
      expect(await c.next('message.done')).toMatchObject({ status: 'error', error: expect.stringContaining(message) })
      // A failed upload is a failed turn: nothing was silently downgraded into inline bytes.
      expect(created).toHaveLength(0)
      expect(await pointersOf(attachmentId)).toHaveLength(0)
    }
  })
})
