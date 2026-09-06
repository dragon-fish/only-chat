import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import type { Context } from 'cordis'
import type { FilesV4, FilesV4UploadFileCallOptions } from '@ai-sdk/provider'
import { DefaultGeneratedFile } from 'ai'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '@/server/app'
import { createDb, type DB } from '@/server/db/client'
import { ensureDefaultUser } from '@/server/plugins/database'
import type { Assets } from '@/server/plugins/assets'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import { buildModelMessages } from '@/server/plugins/llm/messages'
import { MAX_UPLOAD_BYTES, r2Key } from '@/server/plugins/api/attachments'
import type { Hub } from '@/server/plugins/hub'
import { persistGeneratedImage } from '@/server/plugins/hub/generated-images'
import { resolveEffectiveConfig } from '@/server/plugins/hub/effective-config'
import { getProject } from '@/server/plugins/hub/projects'
import { createSession, getSession, insertMessage, listMessages, toMessage } from '@/server/plugins/hub/sessions'
import { attachmentProviderFiles, attachments, models, projects, providers, users } from '@/server/db/schema'
import type { ProviderRow } from '@/server/db/schema'
import { sendCommandFor } from '@/client/stores/sync'
import { DEFAULT_USER_ID } from '@/shared/constants'
import type { Message, ModelCapabilities, SessionParams } from '@/shared/models'
import type { Part } from '@/shared/parts'
import type { UserHub } from '@/server/index'
import { connect, type WsHarness } from './ws-helper'

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

async function seedProvider(name = 'mock', modelId = 'mock-1', nativeFiles = false, capabilities: ModelCapabilities = { reasoning: true }): Promise<number> {
  const db = createDb(env.DB)
  await ensureDefaultUser(db)
  const [p] = await db.insert(providers).values({
    user_id: DEFAULT_USER_ID, name, protocol: 'mock' as never, base_url: 'https://mock',
    api_key: await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'k'), extra: null, enabled: true,
    native_files: nativeFiles, created_at: 0,
  }).returning()
  await db.insert(models).values({ provider_id: p!.id, model_id: modelId, display_name: 'Mock', capabilities, pricing: null, enabled: true, sort: 0 })
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
    user_id: DEFAULT_USER_ID, name: 'P', system_prompt: null, provider_id: null, model_id: null,
    params: null, created_at: 0, updated_at: 0, ...input,
  }).returning()
  return row!.id
}

/** Whatever the DO would replay to a client that reconnects mid-generation. */
async function inflightSnapshot(): Promise<string> {
  const stub = env.USER_HUB.getByName(String(DEFAULT_USER_ID))
  return runInDurableObject(stub, async (_instance: UserHub, state) => {
    const stored = await state.storage.list({ prefix: 'inflight:' })
    return JSON.stringify([...stored.values()])
  })
}

/** Every file part the adapter actually received, across all roles of one call's prompt. */
function filePartsOf(model: MockLanguageModelV4): Array<{ type: string; mediaType: string; data: unknown }> {
  const parts = model.doStreamCalls[0]!.prompt.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string }>) : []))
  return parts.filter((p) => p.type === 'file') as Array<{ type: string; mediaType: string; data: unknown }>
}

const pointersOf = (attachmentId: number) =>
  createDb(env.DB).select().from(attachmentProviderFiles).where(eq(attachmentProviderFiles.attachment_id, attachmentId))

const sessionIdOf = (c: WsHarness) => (c.events.find((e) => e.type === 'session.created') as { session: { id: number } }).session.id

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

  it('accepts the Composer’s own payloads: the draft creates the session, the follow-up omits every init field', async () => {
    // The client builds these commands; a follow-up that nulled the init fields out instead of
    // omitting them would be rejected by the check above, so the builder is exercised end to end.
    const providerId = await seedProvider()
    const projectId = await seedProject({ system_prompt: 'PROJECT' })
    const created = await installMock(streamingMock)
    const c = await connect()
    const model = { provider_id: providerId, model_id: 'mock-1' }
    c.ws.send(JSON.stringify(sendCommandFor({
      sessionId: null, parentId: null, parts: [{ type: 'text', text: 'first' }], model,
      draft: { project_id: projectId, system_prompt: 'DRAFT', model: null, params: { reasoning_enabled: true, reasoning_effort: null } },
    })))
    expect(await c.next('message.done')).toMatchObject({ status: 'done' })

    const sessionId = (c.events.find((e) => e.type === 'session.created') as { session: { id: number } }).session.id
    const row = (await getSession(createDb(env.DB), sessionId))!
    expect(row).toMatchObject({ project_id: projectId, system_prompt: 'DRAFT', provider_id: null, model_id: null })
    // Explicit Auto survives the round trip as `null`, not as an absent (inherited) key.
    expect(row.params).toEqual({ reasoning_enabled: true, reasoning_effort: null })
    expect(created[0]!.doStreamCalls[0]!.prompt[0]).toMatchObject({ role: 'system', content: 'PROJECT\n\nDRAFT' })

    c.ws.send(JSON.stringify(sendCommandFor({
      sessionId, parentId: row.head_message_id, parts: [{ type: 'text', text: 'second' }], model,
      draft: { project_id: projectId, system_prompt: 'DRAFT', model: null, params: null },
    })))
    expect(await c.nextAfter('message.done', 2)).toMatchObject({ status: 'done' })
    expect(c.events.some((e) => e.type === 'error')).toBe(false)
    expect(await listMessages(createDb(env.DB), sessionId)).toHaveLength(4)
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
    return JSON.stringify({ type: 'send', session_id: null, parent_id: null, parts: [{ type: 'text', text: 'draw a cat' }], provider_id: providerId, model_id: modelId })
  }

  const imageEventsOf = (c: WsHarness) => c.events.filter((e) => e.type === 'message.part') as Array<{ part: { attachment_id: number } }>

  it('persists inline image bytes to R2 and gives every device only an attachment id', async () => {
    const bytes = uniqueImageBytes()
    const providerId = await seedProvider('img-inline', 'img-1', false, { image_output: true })
    await installMock(imageMock(textThenFiles([inlineChunk(bytes)])))

    const a = await connect()
    const b = await connect()
    a.ws.send(send(providerId, 'img-1'))
    expect(await a.next('message.done')).toMatchObject({ status: 'done' })
    await b.next('message.done')

    const imageEvent = a.events.find((e) => e.type === 'message.part')!
    expect((imageEvent as { part: unknown }).part).toEqual({ type: 'image', attachment_id: expect.any(Number) })
    expect(JSON.stringify(imageEvent)).not.toContain('base64')
    expect(JSON.stringify(imageEvent)).not.toContain(toBase64(bytes))
    // Multi-device: the second socket received the very same frame, id and all.
    expect(b.events.find((e) => e.type === 'message.part')).toEqual(imageEvent)

    const attachmentId = (imageEvent as { part: { attachment_id: number } }).part.attachment_id
    const saved = (await createDb(env.DB).query.attachments.findFirst({ where: eq(attachments.id, attachmentId) }))!
    expect(saved).toMatchObject({ origin: 'generated', mime: 'image/png', size: bytes.byteLength, sha256: await sha256(bytes) })
    const object = await env.BUCKET.get(saved.r2_key)
    expect(object).not.toBeNull()
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes)

    const rows = await listMessages(createDb(env.DB), sessionIdOf(a))
    expect(rows[1]!.parts).toEqual([
      { type: 'text', text: 'here it is' },
      { type: 'image', attachment_id: attachmentId },
    ])
    expect(JSON.stringify(rows[1]!.parts)).not.toContain('base64')
    expect(JSON.stringify(rows[1]!.parts)).not.toContain(toBase64(bytes))
  })

  it('decodes a base64 output and stores the decoded bytes', async () => {
    const bytes = uniqueImageBytes()
    const providerId = await seedProvider('img-b64', 'img-1', false, { image_output: true })
    await installMock(imageMock(textThenFiles([base64Chunk(bytes)])))

    const c = await connect()
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
    const providerId = await seedProvider('img-url', 'img-1', false, { image_output: true })
    const chunk: StreamPart = { type: 'file', mediaType: 'image/png', data: { type: 'url', url: new URL(url) } }
    await installMock(imageMock(textThenFiles([chunk])))
    vi.stubGlobal('fetch', async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }))

    try {
      const c = await connect()
      c.ws.send(send(providerId, 'img-1'))
      expect(await c.next('message.done')).toMatchObject({ status: 'done' })

      const saved = (await attachmentBySha(await sha256(bytes)))!
      expect(saved.origin).toBe('generated')
      expect(imageEventsOf(c).map((e) => e.part.attachment_id)).toEqual([saved.id])
      // The provider's temporary URL reaches neither the socket nor D1.
      expect(JSON.stringify(c.events)).not.toContain('provider.example')
      const rows = await listMessages(createDb(env.DB), sessionIdOf(c))
      expect(rows[1]!.parts).toEqual([
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
    const providerId = await seedProvider('img-dupe', 'img-1', false, { image_output: true })
    await installMock(imageMock(textThenFiles([inlineChunk(bytes), inlineChunk(bytes)])))

    const c = await connect()
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
    const providerId = await seedProvider('img-bad-mime', 'img-1', false, { image_output: true })
    await installMock(imageMock(textThenFiles([inlineChunk(bytes, 'image/svg+xml')])))

    const c = await connect()
    c.ws.send(send(providerId, 'img-1'))
    expect(await c.next('message.done')).toMatchObject({ status: 'error', error: expect.stringContaining('image/svg+xml') })

    expect(imageEventsOf(c)).toHaveLength(0)
    const rows = await listMessages(createDb(env.DB), sessionIdOf(c))
    expect(rows[1]!.status).toBe('error')
    // Spec §9: the text already received survives, and no trace of the file is written anywhere.
    expect(rows[1]!.parts).toEqual([{ type: 'text', text: 'here it is' }])
    expect(await attachmentBySha(digest)).toBeUndefined()
    expect(await env.BUCKET.head(r2Key(DEFAULT_USER_ID, digest))).toBeNull()
  })

  it('never writes file content into the DO inflight snapshot', async () => {
    const bytes = uniqueImageBytes()
    const providerId = await seedProvider('img-inflight', 'img-1', false, { image_output: true })
    const trailing: StreamPart[] = [
      { type: 'text-start', id: 't2' },
      { type: 'text-delta', id: 't2', delta: 'and more' },
      { type: 'text-end', id: 't2' },
    ]
    await installMock(imageMock(textThenFiles([inlineChunk(bytes)], trailing), 100))

    const c = await connect()
    c.ws.send(send(providerId, 'img-1'))
    // The image part is broadcast only after `flushInflight`, so storage already holds it here.
    await c.next('message.part')
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
    return { db: overrides.db ?? ctx.db.orm, app: { assets: overrides.assets ?? ctx.assets } } as unknown as Hub
  }

  const png = (bytes: Uint8Array<ArrayBuffer>, mediaType = 'image/png') => new DefaultGeneratedFile({ data: bytes, mediaType })

  /** Scoped to the one key those bytes would ever occupy: other test files share this bucket. */
  const storedObject = async (bytes: Uint8Array<ArrayBuffer>) =>
    env.BUCKET.head(r2Key(DEFAULT_USER_ID, await sha256(bytes)))

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
    expect(await env.BUCKET.head(r2Key(DEFAULT_USER_ID, digest))).toBeNull()
  })

  it('keeps the R2 object when a concurrent insert already claimed the same digest', async () => {
    const bytes = uniqueImageBytes()
    const digest = await sha256(bytes)
    const key = r2Key(DEFAULT_USER_ID, digest)
    const ctx = await app()
    // Another writer wins the unique index while this insert is in flight: that row owns the key.
    const db = withFailingInsert(ctx.db.orm, async () => {
      await ctx.db.orm.insert(attachments).values({
        user_id: DEFAULT_USER_ID, sha256: digest, mime: 'image/png', size: bytes.byteLength,
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
    await ensureDefaultUser(db)
    const digest = await sha256(bytes)
    const key = r2Key(DEFAULT_USER_ID, digest)
    await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: 'image/png' } })
    const [row] = await db.insert(attachments).values({
      user_id: DEFAULT_USER_ID, sha256: digest, mime: 'image/png', size: bytes.byteLength,
      width: 1, height: 1, r2_key: key, origin: 'upload', created_at: 0,
    }).returning()
    return row!.id
  }

  it('carries one Project chat through Auto reasoning, an uploaded image, an A → B → A switch, a generated image, a reconnect and Project deletion', async () => {
    const db = createDb(env.DB)
    const providerA = await seedProvider('int-a', 'int-a-1', true, { reasoning: true, image_output: true })
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
      // ---- turn 1: the draft creates the session, the Project supplies prompt, model and params
      const c = await connect()
      c.ws.send(JSON.stringify(sendCommandFor({
        sessionId: null, parentId: null,
        parts: [{ type: 'text', text: 'draw from this' }, { type: 'image', attachment_id: uploadId }],
        // The Composer's own selection is the last fallback, so the Project default must outrank it.
        model: { provider_id: commandProvider, model_id: 'int-cmd-1' },
        draft: { project_id: projectId, system_prompt: 'SESSION', model: null, params: { reasoning_enabled: true, reasoning_effort: null } },
      })))

      const imageEvent = await c.next('message.part')
      const generatedId = (imageEvent as { part: { attachment_id: number } }).part.attachment_id
      expect((imageEvent as { part: unknown }).part).toEqual({ type: 'image', attachment_id: generatedId })

      // A device joining mid-generation is handed the same reduced part, never the provider's link.
      const rejoin = await connect()
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
      const sessionId = sessionIdOf(c)

      const session = (await getSession(db, sessionId))!
      expect(session).toMatchObject({ project_id: projectId, system_prompt: 'SESSION', provider_id: null, model_id: null })
      // Explicit Auto is a present key holding `null`, not an absent (inherited) one — through D1.
      expect(session.params).toEqual({ reasoning_enabled: true, reasoning_effort: null })
      expect('reasoning_effort' in session.params!).toBe(true)

      const firstCall = created[0]!.doStreamCalls[0]!
      expect(firstCall.prompt[0]).toMatchObject({ role: 'system', content: 'PROJECT\n\nSESSION' })
      expect(firstCall).toMatchObject({ temperature: 0.25, maxOutputTokens: 32 })
      const reference = (providerId: number, n: number) =>
        ({ type: 'file', mediaType: 'image/png', data: { type: 'reference', reference: { mock: `file-${providerId}-${n}` } } })
      expect(filePartsOf(created[0]!)).toEqual([reference(providerA, 1)])

      const turn1 = await listMessages(db, sessionId)
      // The Project default won over the command model, and was recorded on the reply.
      expect(turn1[1]).toMatchObject({ provider_id: providerA, model_id: 'int-a-1' })
      expect(turn1[1]!.parts).toEqual([
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
      c.ws.send(JSON.stringify({ type: 'session.update', session_id: sessionId, provider_id: providerB, model_id: 'int-b-1' }))
      expect(await c.next('session.updated')).toMatchObject({ session: { id: sessionId, provider_id: providerB, model_id: 'int-b-1' } })

      c.events.length = 0
      c.ws.send(JSON.stringify({
        type: 'send', session_id: sessionId, parent_id: null, parts: [{ type: 'text', text: 'again' }],
        provider_id: commandProvider, model_id: 'int-cmd-1',
      }))
      expect(await c.next('message.done')).toMatchObject({ status: 'done' })
      expect(filePartsOf(created[1]!)).toEqual([reference(providerB, 1)])

      // ---- turn 3: back to A, whose original pointer is still valid
      c.events.length = 0
      c.ws.send(JSON.stringify({ type: 'session.update', session_id: sessionId, provider_id: providerA, model_id: 'int-a-1' }))
      await c.next('session.updated')
      c.events.length = 0
      c.ws.send(JSON.stringify({
        type: 'send', session_id: sessionId, parent_id: null, parts: [{ type: 'text', text: 'once more' }],
        provider_id: commandProvider, model_id: 'int-cmd-1',
      }))
      expect(await c.next('message.done')).toMatchObject({ status: 'done' })
      expect(filePartsOf(created[2]!)).toEqual([reference(providerA, 1)])

      // The pointer is scoped to (attachment, provider) and to nothing else: no session, no model.
      const uploadsForImage = uploads.filter((u) => u.options.filename === `attachment-${uploadId}.png`)
      expect(uploadsForImage.map((u) => u.providerId)).toEqual([providerA, providerB])
      const pointers = await pointersOf(uploadId)
      expect(pointers.map((r) => r.provider_id).sort((x, y) => x - y)).toEqual([providerA, providerB].sort((x, y) => x - y))
      expect(Object.keys(pointers[0]!).sort())
        .toEqual(['attachment_id', 'created_at', 'expires_at', 'id', 'provider_id', 'provider_reference'])

      // Nothing in this chat's persisted history is bytes, base64 or a provider URL.
      const history = await listMessages(db, sessionId)
      const json = JSON.stringify(history.map((r) => r.parts))
      expect(json).not.toContain('provider.example')
      expect(json).not.toContain('base64')
      expect(json).not.toContain(toBase64(generatedBytes))
      expect(json).not.toContain(toBase64(uploadBytes))

      // ---- deleting the Project releases the chat instead of destroying it
      c.events.length = 0
      c.ws.send(JSON.stringify({ type: 'project.delete', project_id: projectId }))
      expect(await c.next('project.deleted')).toEqual({ type: 'project.deleted', project_id: projectId })
      expect(await c.next('session.updated')).toMatchObject({ session: { id: sessionId, project_id: null } })

      const released = (await getSession(db, sessionId))!
      expect(released.project_id).toBeNull()
      // Its own override, its history and its media all outlive the Project that framed them.
      expect(released).toMatchObject({ provider_id: providerA, model_id: 'int-a-1', system_prompt: 'SESSION' })
      expect(await listMessages(db, sessionId)).toHaveLength(history.length)
      expect(await env.BUCKET.head(generated.r2_key)).not.toBeNull()
      expect(await db.query.attachments.findFirst({ where: eq(attachments.id, generatedId) })).toBeDefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the three reasoning states apart across a D1 round trip', async () => {
    const db = createDb(env.DB)
    await ensureDefaultUser(db)
    const projectId = await seedProject({ params: { reasoning_enabled: true, reasoning_effort: 'medium' } })
    const project = (await getProject(db, projectId, DEFAULT_USER_ID))!

    // Absent means inherit, `null` means explicit Auto, a string means an explicit strength. The
    // distinction lives in a JSON column, so only a real write and read back can prove it survives.
    const cases: Array<{ params: SessionParams; key: boolean; effort: string | null }> = [
      { params: { reasoning_effort: 'high' }, key: true, effort: 'high' },
      { params: { reasoning_enabled: true, reasoning_effort: null }, key: true, effort: null },
      { params: { temperature: 0.2 }, key: false, effort: 'medium' },
    ]
    for (const { params, key, effort } of cases) {
      const created = await createSession(db, {
        user_id: DEFAULT_USER_ID, title: 'r', project_id: projectId, provider_id: null, model_id: null, params,
      })
      const stored = (await getSession(db, created.id))!
      expect('reasoning_effort' in (stored.params ?? {})).toBe(key)
      expect(resolveEffectiveConfig({ session: stored, project }).params.reasoning_effort).toBe(effort)
    }
  })
})
