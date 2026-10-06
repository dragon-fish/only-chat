import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { APICallError } from 'ai'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { models, providerInterfaces, providers, users } from '@/server/db/schema'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import { getConversation, listMessages } from '@/server/plugins/hub/conversations'
import type { UserHub } from '@/server/index'
import type { UserSettings } from '@/shared/models'
import type { CheckpointPart } from '@/shared/parts'
import type { WsEvent } from '@/shared/ws'
import { NO_FALLBACK_ERROR } from '@/plugins/context-compaction/server/summarize'
import { INEFFECTIVE_MESSAGE } from '@/plugins/context-compaction/server/manager'
import type { CompactionData, CompactionEvent } from '@/plugins/context-compaction/shared'
import { ensureTestUser } from './auth-helper'
import { connect, type WsHarness } from './ws-helper'

type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>
type CallOptions = Parameters<MockLanguageModelV4['doGenerate']>[0]
type Prompt = CallOptions['prompt']

const MODEL = 'mock-compaction'
const FALLBACK = 'mock-fallback'
/** Trigger line 80k; a cached summary fits while the request is under about 81k. */
const CONTEXT = 100_000

const usage = (input: number, output = 2) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 }, raw: {},
})

function reply(body: string, input: number): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: body },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(input) },
  ]
}

function toolStep(id: string, input: number): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: id, toolName: 'echo', input: '{}' },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: usage(input) },
  ]
}

const overflow = () => new APICallError({
  message: 'Bad Request', url: 'https://compaction.example/responses-api', requestBodyValues: {}, statusCode: 400,
  responseBody: '{"error":{"message":"Your input exceeds the context window of this model","code":"context_length_exceeded"}}',
})

const summary = (text: string, finish: 'stop' | 'length' = 'stop'): GenerateResult => ({
  content: [{ type: 'text', text }], finishReason: { unified: finish, raw: finish }, usage: usage(500, 40), warnings: [],
})
const callsTool = (): GenerateResult => ({
  content: [{ type: 'tool-call', toolCallId: 'x1', toolName: 'echo', input: '{}' }],
  finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: usage(500, 5), warnings: [],
})

/** Chat replies, in order. */
let streams: Array<StreamPart[] | Error | { chunks: StreamPart[], delay: number }> = []
/** Summary replies, in order. */
let summaries: GenerateResult[] = []
/** Every summary request, with the model it went to. */
const generated: Array<{ modelId: string, options: CallOptions }> = []
const chatPrompts: Prompt[] = []
let echoRuns = 0

const hubStub = () => env.USER_HUB.getByName('1')
const db = () => createDb(env.DB)
let ids: { provider: number, fallbackProvider: number } | undefined

async function setSettings(settings: UserSettings): Promise<void> {
  await db().update(users).set({ settings }).where(eq(users.id, 1))
}
const SWITCHES = { ask_user: true, context_compaction: true }

async function setAuto(auto: boolean): Promise<void> {
  await runInDurableObject(hubStub(), (instance: UserHub) => instance.app.pluginConfig.write(1, 'context_compaction', { auto }))
}

async function addProvider(name: string, modelId: string, metadata: Record<string, unknown>): Promise<number> {
  const [provider] = await db().insert(providers).values({
    user_id: 1, name, api_key: await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'k'), enabled: true, created_at: 0,
  }).returning()
  const [selected] = await db().insert(providerInterfaces).values({
    provider_id: provider!.id, protocol: 'responses', base_url: `https://${name}.example/responses-api`, created_at: 0,
  }).returning()
  await db().update(providers).set({ default_interface_id: selected!.id }).where(eq(providers.id, provider!.id))
  await db().insert(models).values({ provider_id: provider!.id, model_id: modelId, metadata_resolved: metadata, enabled: true, sort: 0 })
  return provider!.id
}

async function setup(): Promise<void> {
  await ensureTestUser(db())
  await setSettings({ plugins: SWITCHES })
  if (ids) {
    await setAuto(true)
    return
  }
  const provider = await addProvider('compaction', MODEL, { tool_call: true, limit: { context: CONTEXT, output: 32_000 } })
  const fallbackProvider = await addProvider('fallback', FALLBACK, {
    modalities: { input: ['text'], output: ['text'] }, limit: { context: 50_000, output: 8000 },
  })
  await connect(await ensureTestUser())
  await runInDurableObject(hubStub(), async (instance: UserHub) => {
    await instance.app.plugin({
      name: 'context-compaction-mock',
      inject: ['llm'],
      apply(c) {
        c.llm.register('responses', {
          createModel: (_provider, _iface, model) => new MockLanguageModelV4({
            modelId: model.model_id,
            doStream: async ({ prompt }) => {
              chatPrompts.push(prompt)
              const next = streams.shift()
              if (next === undefined) throw new Error('stream script exhausted')
              if (next instanceof Error) throw next
              const [chunks, delay] = Array.isArray(next) ? [next, null] : [next.chunks, next.delay]
              return { stream: simulateReadableStream({ chunks, chunkDelayInMs: delay, initialDelayInMs: null }) }
            },
            doGenerate: async (options) => {
              generated.push({ modelId: model.model_id, options })
              const next = summaries.shift()
              if (next === undefined) throw new Error('summary script exhausted')
              return next
            },
          }) as never,
        })
      },
    })
    instance.app.tools.register('ask_user', 'echo', () => ({
      description: 'echo', inputSchema: z.object({}), execute: async () => { echoRuns++; return { ok: true } },
    }))
  })
  ids = { provider, fallbackProvider }
  await setAuto(true)
}

beforeEach(() => {
  streams = []
  summaries = []
  generated.length = 0
  echoRuns = 0
})

const rowsOf = (conversationId: number) => listMessages(db(), conversationId, 1)
const isCheckpoint = (row: { parts: unknown[] }) => (row.parts[0] as { type?: string } | undefined)?.type === 'checkpoint'
const shape = async (conversationId: number) => (await rowsOf(conversationId)).map(row => (isCheckpoint(row) ? 'checkpoint' : row.role))

function textOf(message: Prompt[number]): string {
  if (typeof message.content === 'string') return message.content
  return (message.content as Array<{ type: string, text?: string }>).map(part => part.text ?? '').join('')
}

async function idle(): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const busy = await runInDurableObject(hubStub(), (instance: UserHub) =>
      instance.app.hub.inflight().length > 0 || instance.app.hub.operations.heldConversations().length > 0)
    if (!busy) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('hub never went idle')
}

function send(c: WsHarness, conversationId: number | null, body: string): void {
  c.ws.send(JSON.stringify({
    type: 'send', conversation_id: conversationId, parent_id: null, parts: [{ type: 'text', text: body }],
    provider_id: ids!.provider, model_id: MODEL,
    ...(conversationId === null ? { tools: ['echo'] } : {}),
  }))
}

const conversationIdOf = (c: WsHarness) =>
  (c.events.find(event => event.type === 'conversation.created') as Extract<WsEvent, { type: 'conversation.created' }>).conversation.id

/** A conversation whose first reply measured `input` tokens, settled with whatever that triggered. */
async function chatted(input: number): Promise<{ c: WsHarness, conversationId: number }> {
  const c = await connect(await ensureTestUser())
  streams.push(reply('first answer', input))
  send(c, null, 'first question')
  await c.nextAfter('message.done', 1)
  await idle()
  return { c, conversationId: conversationIdOf(c) }
}

const pluginEvents = (c: WsHarness) => c.events
  .filter((event): event is Extract<WsEvent, { type: 'plugin.event' }> => event.type === 'plugin.event' && event.plugin === 'context_compaction')
  .map(event => event.payload as CompactionEvent)

async function compress(c: WsHarness, conversationId: number, requestId: string, focus?: string): Promise<CompactionEvent> {
  c.ws.send(JSON.stringify({ type: 'plugin.command', plugin: 'context_compaction', payload: { type: 'compress', requestId, conversationId, focus } }))
  for (let attempt = 0; attempt < 300; attempt++) {
    const found = pluginEvents(c).find(event => event.type === 'compress.result' && event.requestId === requestId)
    if (found) return found
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('no compress.result')
}

const checkpointOf = async (conversationId: number) => {
  const row = (await rowsOf(conversationId)).find(isCheckpoint)!
  return { row, part: row.parts[0] as CheckpointPart, data: (row.parts[0] as CheckpointPart).data as CompactionData }
}

describe('context compaction plugin', () => {
  it('compacts after a turn over the trigger line from the cached prefix, and the next turn opens with it', async () => {
    await setup()
    summaries.push(summary('SUMMARY TEXT'))
    const { c, conversationId } = await chatted(81_000)

    expect(await shape(conversationId)).toEqual(['user', 'assistant', 'checkpoint'])
    const { row, part, data } = await checkpointOf(conversationId)
    expect(part.plugin).toBe('context_compaction')
    expect(data).toMatchObject({ trigger: 'auto', mode: 'cached', summary: 'SUMMARY TEXT', focus: null, files: { read: [], modified: [] } })
    expect(data.tokensBefore).toBeGreaterThan(80_000)
    expect(row.usage).toMatchObject({ prompt: 500, completion: 40 })
    expect(part.content).toContain('<summary>\nSUMMARY TEXT\n</summary>')
    expect(part.content).toMatch(/<recent-transcript[^>]*>\n\[User\]: first question\n\[Assistant\]: first answer\n<\/recent-transcript>/)

    // The summary request is the turn's own request plus the instruction, offering the tools it had.
    const [call] = generated
    expect(call!.modelId).toBe(MODEL)
    expect(call!.options.prompt.at(-1)).toMatchObject({ role: 'user' })
    expect(textOf(call!.options.prompt.at(-1)!)).toContain('write a summary of the conversation so far')
    expect(call!.options.prompt.map(textOf).join('\n')).toContain('first question')
    expect(call!.options.tools?.map(tool => tool.name)).toEqual(['echo'])
    expect(call!.options.toolChoice).toEqual({ type: 'auto' })

    streams.push(reply('second answer', 2000))
    send(c, conversationId, 'second question')
    await c.nextAfter('message.done', 2)
    await idle()
    const prompt = chatPrompts.at(-1)!
    const opening = prompt.find(message => message.role !== 'system')!
    expect(textOf(opening)).toBe(part.content)
    // The first exchange reaches the model only through the checkpoint.
    expect(prompt.filter(message => message.role === 'assistant')).toEqual([])
  })

  it('stops compacting automatically when the checkpoint did not bring the context under the line', async () => {
    await setup()
    summaries.push(summary('SUMMARY TEXT'))
    const { c, conversationId } = await chatted(81_000)
    expect(await shape(conversationId)).toEqual(['user', 'assistant', 'checkpoint'])

    streams.push(reply('second answer', 85_000), reply('third answer', 86_000))
    send(c, conversationId, 'second question')
    await c.nextAfter('message.done', 2)
    await idle()
    send(c, conversationId, 'third question')
    await c.nextAfter('message.done', 3)
    await idle()

    expect(await shape(conversationId)).toEqual(['user', 'assistant', 'checkpoint', 'user', 'assistant', 'user', 'assistant'])
    expect(generated).toHaveLength(1)
    const notices = pluginEvents(c).filter(event => event.type === 'notice')
    expect(notices).toEqual([{ type: 'notice', conversationId, kind: 'ineffective', message: INEFFECTIVE_MESSAGE }])
  })

  it('compacts between two steps and carries the turn on with its request', async () => {
    await setup()
    const c = await connect(await ensureTestUser())
    streams.push(toolStep('c1', 81_000), reply('done after compaction', 3000))
    summaries.push(summary('MID SUMMARY'))
    send(c, null, 'work hard')
    await c.nextAfter('message.done', 2)
    await idle()

    const conversationId = conversationIdOf(c)
    expect(await shape(conversationId)).toEqual(['user', 'assistant', 'checkpoint', 'assistant'])
    const { part, data } = await checkpointOf(conversationId)
    expect(data).toMatchObject({ trigger: 'auto', mode: 'cached' })
    const tail = part.content.slice(part.content.indexOf('</compacted-context>'))
    expect(tail).toContain('<user-input>\nwork hard\n</user-input>')
    expect(tail).toMatch(/Continue from where the recent transcript ends/)
    expect(part.content).toContain('[Tool call] echo({})')
    expect(echoRuns).toBe(1)

    const continued = chatPrompts.at(-1)!
    expect(textOf(continued.find(message => message.role !== 'system')!)).toBe(part.content)
  })

  it('recovers from a provider overflow through the fallback model and continues', async () => {
    await setup()
    await setSettings({ plugins: SWITCHES, service_models: { compaction: { provider_id: ids!.fallbackProvider, model_id: FALLBACK } } })
    const c = await connect(await ensureTestUser())
    streams.push(overflow(), reply('recovered', 3000))
    summaries.push(summary('OVERFLOW SUMMARY'))
    send(c, null, 'huge request')
    await c.nextAfter('message.done', 2)
    await idle()

    const conversationId = conversationIdOf(c)
    expect(await shape(conversationId)).toEqual(['user', 'assistant', 'checkpoint', 'assistant'])
    const { data, part } = await checkpointOf(conversationId)
    expect(data).toMatchObject({ trigger: 'overflow', mode: 'flattened', tokensBefore: CONTEXT })
    expect(generated.map(call => call.modelId)).toEqual([FALLBACK])
    expect(part.content).toContain('<user-input>\nhuge request\n</user-input>')
    expect((await rowsOf(conversationId)).at(-1)).toMatchObject({ status: 'done', parts: [{ type: 'text', text: 'recovered' }] })
  })

  it('asks again once when the summary calls a tool, never running it', async () => {
    await setup()
    summaries.push(callsTool(), summary('SECOND TRY'))
    const { conversationId } = await chatted(81_000)

    expect(await shape(conversationId)).toEqual(['user', 'assistant', 'checkpoint'])
    expect((await checkpointOf(conversationId)).data.summary).toBe('SECOND TRY')
    expect(generated).toHaveLength(2)
    expect(textOf(generated[1]!.options.prompt.at(-1)!)).toContain('Your previous reply called a tool')
    expect(echoRuns).toBe(0)
  })

  it('fails when the summary calls a tool twice, and says so', async () => {
    await setup()
    summaries.push(callsTool(), callsTool())
    const { c, conversationId } = await chatted(81_000)

    expect(await shape(conversationId)).toEqual(['user', 'assistant'])
    expect(generated).toHaveLength(2)
    expect(echoRuns).toBe(0)
    expect(pluginEvents(c)).toEqual([expect.objectContaining({ type: 'notice', conversationId, kind: 'failed' })])
  })

  it('refuses a truncated summary', async () => {
    await setup()
    summaries.push(summary('half a summ', 'length'))
    const { c, conversationId } = await chatted(81_000)
    expect(await shape(conversationId)).toEqual(['user', 'assistant'])
    expect(pluginEvents(c)).toEqual([expect.objectContaining({ kind: 'failed', message: expect.stringContaining('截断') })])
  })

  it('flattens the conversation for the fallback model when the cache cannot take the summary', async () => {
    await setup()
    await setSettings({ plugins: SWITCHES, service_models: { compaction: { provider_id: ids!.fallbackProvider, model_id: FALLBACK } } })
    summaries.push(summary('FLAT SUMMARY'))
    const { conversationId } = await chatted(98_000)

    expect(await shape(conversationId)).toEqual(['user', 'assistant', 'checkpoint'])
    const { data, part } = await checkpointOf(conversationId)
    expect(data).toMatchObject({ mode: 'flattened', trigger: 'auto', summary: 'FLAT SUMMARY' })
    expect(part.content).toContain('FLAT SUMMARY')
    const [call] = generated
    expect(call!.modelId).toBe(FALLBACK)
    expect(call!.options.tools ?? []).toEqual([])
    expect(call!.options.prompt).toHaveLength(1)
    expect(textOf(call!.options.prompt[0]!)).toMatch(/<conversation>\n\[User\]: first question\n\[Assistant\]: first answer\n<\/conversation>/)
    expect(call!.options.maxOutputTokens).toBe(8000)
  })

  it('fails without a fallback model when the cache cannot take the summary', async () => {
    await setup()
    const { c, conversationId } = await chatted(98_000)
    expect(await shape(conversationId)).toEqual(['user', 'assistant'])
    expect(generated).toHaveLength(0)
    expect(pluginEvents(c)).toEqual([{ type: 'notice', conversationId, kind: 'failed', message: `上下文压缩失败：${NO_FALLBACK_ERROR}` }])
  })

  it('compacts on /compress with the person’s focus and answers the request', async () => {
    await setup()
    const { c, conversationId } = await chatted(1000)
    expect(await shape(conversationId)).toEqual(['user', 'assistant'])

    summaries.push(summary('MANUAL SUMMARY'))
    expect(await compress(c, conversationId, 'r1', 'keep the numbers')).toEqual({ type: 'compress.result', requestId: 'r1', ok: true })
    expect(await shape(conversationId)).toEqual(['user', 'assistant', 'checkpoint'])
    expect((await checkpointOf(conversationId)).data).toMatchObject({ trigger: 'manual', focus: 'keep the numbers', mode: 'cached' })
    expect(textOf(generated[0]!.options.prompt.at(-1)!)).toContain('keep the numbers')
    expect((await getConversation(db(), conversationId, 1))!.head_message_id).toBe((await checkpointOf(conversationId)).row.id)
  })

  it('refuses /compress while the conversation is generating', async () => {
    await setup()
    const { c, conversationId } = await chatted(1000)
    streams.push({ chunks: reply('slow answer', 1000), delay: 100 })
    send(c, conversationId, 'second question')
    await c.next('message.delta')

    const answer = await compress(c, conversationId, 'r2')
    expect(answer).toMatchObject({ type: 'compress.result', requestId: 'r2', ok: false, error: '正在生成回复' })
    await c.nextAfter('message.done', 2)
    await idle()
    expect(await shape(conversationId)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(generated).toHaveLength(0)
  })

  it('leaves compaction to /compress when automatic compaction is off', async () => {
    await setup()
    await setAuto(false)
    const { c, conversationId } = await chatted(81_000)
    expect(await shape(conversationId)).toEqual(['user', 'assistant'])
    expect(generated).toHaveLength(0)

    summaries.push(summary('BY HAND'))
    expect(await compress(c, conversationId, 'r3')).toMatchObject({ ok: true })
    expect(await shape(conversationId)).toEqual(['user', 'assistant', 'checkpoint'])
  })
})
