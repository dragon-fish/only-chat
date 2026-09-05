import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { ensureDefaultUser } from '@/server/plugins/database'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import { getSession, listMessages } from '@/server/plugins/hub/sessions'
import { models, projects, providers, users } from '@/server/db/schema'
import { DEFAULT_USER_ID } from '@/shared/constants'
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

async function seedProvider(name = 'mock', modelId = 'mock-1'): Promise<number> {
  const db = createDb(env.DB)
  await ensureDefaultUser(db)
  const [p] = await db.insert(providers).values({
    user_id: DEFAULT_USER_ID, name, protocol: 'mock' as never, base_url: 'https://mock',
    api_key: await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'k'), extra: null, enabled: true, created_at: 0,
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

async function installMock(mockFactory: () => MockLanguageModelV4): Promise<MockLanguageModelV4[]> {
  const created: MockLanguageModelV4[] = []
  const stub = env.USER_HUB.getByName(String(DEFAULT_USER_ID))
  await runInDurableObject(stub, async (instance: UserHub) => {
    await instance.app.plugin({
      name: 'mock-protocol',
      inject: ['llm'],
      apply(c) { c.llm.register('mock', () => { const m = mockFactory(); created.push(m); return m as never }) },
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
