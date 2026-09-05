import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { ensureDefaultUser } from '@/server/plugins/database'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import { listMessages } from '@/server/plugins/hub/sessions'
import { models, providers } from '@/server/db/schema'
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

async function seedProvider(): Promise<number> {
  const db = createDb(env.DB)
  await ensureDefaultUser(db)
  const [p] = await db.insert(providers).values({
    user_id: DEFAULT_USER_ID, name: 'mock', protocol: 'mock' as never, base_url: 'https://mock',
    api_key: await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'k'), extra: null, enabled: true, created_at: 0,
  }).returning()
  await db.insert(models).values({ provider_id: p!.id, model_id: 'mock-1', display_name: 'Mock', capabilities: { reasoning: true }, pricing: null, enabled: true, sort: 0 })
  return p!.id
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
    expect(done).toMatchObject({ status: 'aborted' })
    const rows = await listMessages(createDb(env.DB), sessionId)
    expect(rows[1]!.status).toBe('aborted')
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
