import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { models, providerInterfaces, providers, users } from '@/server/db/schema'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import { createConversation, getConversation, insertMessage, listMessages, updateConversation } from '@/server/plugins/hub/conversations'
import { COMPACTING_MESSAGE } from '@/server/plugins/hub/operations'
import { TOOL_MAX_STEPS } from '@/shared/constants'
import type { CheckpointDraft, ComposeInput, ContextDecision, ContextManager, StepInput, TurnInput } from '@/server/plugins/context-manager'
import type { UserHub } from '@/server/index'
import type { CheckpointPart } from '@/shared/parts'
import type { WsEvent } from '@/shared/ws'
import { ensureTestUser } from './auth-helper'
import { connect, type WsHarness } from './ws-helper'

type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never
type Prompt = Parameters<MockLanguageModelV4['doStream']>[0]['prompt']
type Step = StreamPart[] | Error | { chunks: StreamPart[], delay: number }

const MODEL = 'mock-cm'
const OVERFLOW = 'context_length_exceeded'

const usage = (input: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 }, raw: {},
})

function text(body: string, input = 100): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: 'r', modelId: 'mock', timestamp: new Date(0) },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: body },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(input) },
  ]
}

function toolCall(id: string, input = 100): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: 'r', modelId: 'mock', timestamp: new Date(0) },
    { type: 'tool-call', toolCallId: id, toolName: 'echo', input: '{}' },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: usage(input) },
  ]
}

/** What the next requests answer, in order. An `Error` is thrown by the request itself. */
let script: Step[] = []
/** Every prompt the model was sent in this file. */
const prompts: Prompt[] = []

interface Behavior {
  beforeTurn: (input: TurnInput) => ContextDecision
  afterStep: (input: StepInput) => ContextDecision
  afterTurn: (input: TurnInput) => ContextDecision
  compose: (input: ComposeInput) => Promise<CheckpointDraft | { error: string }>
}

const calls = { beforeTurn: [] as TurnInput[], afterStep: [] as StepInput[], afterTurn: [] as TurnInput[], compose: [] as ComposeInput[] }
let behavior: Behavior

const draft = (content = 'SUMMARY'): CheckpointDraft => ({ content, attachments: [], data: { kind: 'fake' }, usage: { prompt: 7, completion: 3 } })

/** Forwards to whatever `behavior` says now, recording every call. */
const fake: ContextManager = {
  beforeTurn: (input) => { calls.beforeTurn.push(input); return behavior.beforeTurn(input) },
  afterStep: (input) => { calls.afterStep.push(input); return behavior.afterStep(input) },
  afterTurn: (input) => { calls.afterTurn.push(input); return behavior.afterTurn(input) },
  isOverflow: error => error instanceof Error && error.message.includes(OVERFLOW),
  compose: (input) => { calls.compose.push(input); return behavior.compose(input) },
}

beforeEach(() => {
  script = []
  for (const list of Object.values(calls)) list.length = 0
  behavior = {
    beforeTurn: () => 'continue',
    afterStep: () => 'continue',
    afterTurn: () => 'continue',
    compose: async () => draft(),
  }
})

const hubStub = () => env.USER_HUB.getByName('1')
const db = () => createDb(env.DB)
let providerId: number | undefined
let unregister: (() => void) | undefined

async function setSwitches(plugins: Record<string, boolean>): Promise<void> {
  await db().update(users).set({ settings: { plugins } }).where(eq(users.id, 1))
}

async function setup(): Promise<number> {
  await ensureTestUser(db())
  await setSwitches({ ask_user: true, context_compaction: true })
  if (providerId !== undefined) return providerId
  const [provider] = await db().insert(providers).values({
    user_id: 1, name: 'context-manager', api_key: await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'k'), enabled: true, created_at: 0,
  }).returning()
  const [selected] = await db().insert(providerInterfaces).values({
    provider_id: provider!.id, protocol: 'responses', base_url: 'https://mock.example/responses-api', created_at: 0,
  }).returning()
  await db().update(providers).set({ default_interface_id: selected!.id }).where(eq(providers.id, provider!.id))
  await db().insert(models).values({
    provider_id: provider!.id, model_id: MODEL, metadata_resolved: { tool_call: true, limit: { context: 1000, output: 100 } }, enabled: true, sort: 0,
  })
  await connect(await ensureTestUser())
  await runInDurableObject(hubStub(), async (instance: UserHub) => {
    await instance.app.plugin({
      name: 'context-manager-mock',
      inject: ['llm'],
      apply(c) {
        c.llm.register('responses', {
          createModel: () => new MockLanguageModelV4({
            doStream: async ({ prompt }) => {
              prompts.push(prompt)
              const next = script.shift()
              if (next === undefined) throw new Error('script exhausted')
              if (next instanceof Error) throw next
              const [chunks, delay] = Array.isArray(next) ? [next, null] : [next.chunks, next.delay]
              return { stream: simulateReadableStream({ chunks, chunkDelayInMs: delay, initialDelayInMs: null }) }
            },
          }) as never,
        })
      },
    })
    // A tool that answers at once, so a run reaches its next step.
    instance.app.tools.register('ask_user', 'echo', () => ({
      description: 'echo', inputSchema: z.object({}), execute: async () => ({ ok: true }),
    }))
    unregister = instance.app.contextManager.register('context_compaction', fake)
  })
  providerId = provider!.id
  return providerId
}

const rowsOf = (conversationId: number) => listMessages(db(), conversationId, 1)
const headOf = async (conversationId: number) => (await getConversation(db(), conversationId, 1))!.head_message_id
const isCheckpoint = (row: { parts: unknown[] }) => (row.parts[0] as { type?: string } | undefined)?.type === 'checkpoint'

/** The text a prompt message carries, whatever its shape. */
function textOf(message: Prompt[number]): string {
  if (typeof message.content === 'string') return message.content
  return (message.content as Array<{ type: string, text?: string }>).map(part => part.text ?? '').join('')
}

/** The first message after any system prompt. */
const opening = (prompt: Prompt) => prompt.find(message => message.role !== 'system')!

async function idle(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
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
    provider_id: providerId, model_id: MODEL,
    // An init field: only a new conversation takes it, and keeps it.
    ...(conversationId === null ? { tools: ['echo'] } : {}),
  }))
}

async function finished(c: WsHarness, done: number): Promise<void> {
  await c.nextAfter('message.done', done)
  await idle()
}

const conversationIdOf = (c: WsHarness) =>
  (c.events.find(event => event.type === 'conversation.created') as Extract<WsEvent, { type: 'conversation.created' }>).conversation.id

/** A conversation with one finished exchange, made through the socket. */
async function chatted(): Promise<{ c: WsHarness, conversationId: number }> {
  const c = await connect(await ensureTestUser())
  script.push(text('first answer'))
  send(c, null, 'first question')
  await finished(c, 1)
  return { c, conversationId: conversationIdOf(c) }
}

const requestCheckpoint = (conversationId: number, focus?: string) =>
  runInDurableObject(hubStub(), (instance: UserHub) => instance.app.hub.compaction.requestCheckpoint({ conversationId, focus }))

describe('context manager hooks', () => {
  it('stay silent while the plugin is switched off', async () => {
    await setup()
    await setSwitches({ ask_user: true })
    behavior.beforeTurn = () => 'checkpoint'
    behavior.afterTurn = () => 'checkpoint'
    const { conversationId } = await chatted()

    expect(Object.values(calls).map(list => list.length)).toEqual([0, 0, 0, 0])
    expect((await rowsOf(conversationId)).map(row => row.role)).toEqual(['user', 'assistant'])
  })

  it('stay silent with no manager registered', async () => {
    await setup()
    await runInDurableObject(hubStub(), () => unregister!())
    try {
      const { conversationId } = await chatted()
      expect(Object.values(calls).map(list => list.length)).toEqual([0, 0, 0, 0])
      expect((await rowsOf(conversationId)).map(row => row.role)).toEqual(['user', 'assistant'])
    } finally {
      await runInDurableObject(hubStub(), (instance: UserHub) => {
        unregister = instance.app.contextManager.register('context_compaction', fake)
      })
    }
  })

  it('refuses a second registration', async () => {
    await setup()
    await expect(runInDurableObject(hubStub(), (instance: UserHub) => {
      instance.app.contextManager.register('other', fake)
    })).rejects.toThrow(/already registered/)
  })

  it('writes a checkpoint under the user message before the reply exists, and the reply reads it', async () => {
    await setup()
    const { c, conversationId } = await chatted()
    behavior.beforeTurn = () => 'checkpoint'
    script.push(text('second answer'))
    send(c, conversationId, 'second question')
    await finished(c, 2)

    const rows = await rowsOf(conversationId)
    expect(rows.map(row => (isCheckpoint(row) ? 'checkpoint' : row.role))).toEqual(['user', 'assistant', 'user', 'checkpoint', 'assistant'])
    const [, , question, checkpoint, reply] = rows
    expect(checkpoint).toMatchObject({ parent_id: question!.id, usage: { prompt: 7, completion: 3 }, provider_id: null })
    expect(checkpoint!.parts[0]).toEqual({
      type: 'checkpoint', plugin: 'context_compaction', content: 'SUMMARY', attachments: [], contributors: [], data: { kind: 'fake' },
    } satisfies CheckpointPart)
    expect(reply).toMatchObject({ parent_id: checkpoint!.id, status: 'done' })
    expect(await headOf(conversationId)).toBe(reply!.id)
    // No reply was opened before the hook decided, so no empty one was left behind.
    expect(c.events.filter(event => event.type === 'message.created' && event.message.role === 'assistant')).toHaveLength(3)

    const [compose] = calls.compose
    expect(compose).toMatchObject({ trigger: 'auto', focus: null, model: { modelId: MODEL, contextLimit: 1000 } })
    expect(compose!.turn!.inputs.map(message => message.id)).toEqual([question!.id])
    expect(textOf(compose!.messages.at(-1)! as Prompt[number])).toContain('second question')
    expect(Object.keys(compose!.tools)).toEqual(['echo'])
    expect(compose!.tools.echo!.execute).toBeUndefined()

    const prompt = prompts.at(-1)!
    expect(opening(prompt)).toMatchObject({ role: 'user' })
    expect(textOf(opening(prompt))).toBe('SUMMARY')
    expect(prompt.map(textOf).join('\n')).not.toContain('first answer')
  })

  it('ends a reply at a step boundary, compacts, and continues under the checkpoint within the remaining budget', async () => {
    await setup()
    const c = await connect(await ensureTestUser())
    behavior.afterStep = input => (input.stepsUsed === 2 ? 'checkpoint' : 'continue')
    const continuation = TOOL_MAX_STEPS - 2
    script.push(toolCall('c1', 100), toolCall('c2', 300))
    for (let step = 0; step < continuation; step++) script.push(toolCall(`k${step}`))
    script.push(text('never asked'))
    send(c, null, 'work hard')
    await finished(c, 2)

    const conversationId = conversationIdOf(c)
    const rows = await rowsOf(conversationId)
    expect(rows.map(row => (isCheckpoint(row) ? 'checkpoint' : row.role))).toEqual(['user', 'assistant', 'checkpoint', 'assistant'])
    const [question, first, checkpoint, second] = rows
    // Finished as a reply, not as an interruption, with the usage of both of its steps.
    expect(first).toMatchObject({ status: 'done', error: null, usage: { prompt: 400, steps: [{ prompt: 100 }, { prompt: 300 }] } })
    expect(first!.parts.map(part => part.type)).toEqual(['tool_call', 'tool_result', 'tool_call', 'tool_result'])
    expect(checkpoint!.parent_id).toBe(first!.id)
    expect(second).toMatchObject({ parent_id: checkpoint!.id, status: 'done' })
    // The rest of the turn's budget, and not a step more.
    expect(second!.parts.filter(part => part.type === 'tool_call')).toHaveLength(continuation)
    expect(script).toHaveLength(1)

    const step = calls.afterStep.find(input => input.stepsUsed === 2)!
    expect(step.steps.map(usage => usage.prompt)).toEqual([100, 300])
    expect(step.lastStep).toEqual({ usage: expect.objectContaining({ prompt: 300 }), messageId: first!.id })
    expect(step.toolResults.map(result => result.call_id)).toEqual(['c2'])
    // The continuation counts on from where the first reply stopped.
    expect(calls.afterStep.filter(input => input.stepsUsed > 2).map(input => input.stepsUsed)[0]).toBe(3)

    const [compose] = calls.compose
    expect(compose).toMatchObject({ trigger: 'auto', turn: { pendingToolAttachments: [] } })
    expect(compose!.turn!.inputs.map(message => message.id)).toEqual([question!.id])
    expect(compose!.messages.at(-1)).toMatchObject({ role: 'tool' })

    const continued = prompts.at(-(continuation))!
    expect(textOf(opening(continued))).toBe('SUMMARY')
    expect(continued.map(textOf).join('\n')).not.toContain('work hard')
  })

  it('delivers what was interjected during the compacted step as the person’s message under the checkpoint', async () => {
    await setup()
    const c = await connect(await ensureTestUser())
    behavior.afterStep = input => (input.stepsUsed === 2 ? 'checkpoint' : 'continue')
    const slowStep: StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'working' },
      { type: 'text-end', id: 't1' },
      { type: 'tool-call', toolCallId: 'c2', toolName: 'echo', input: '{}' },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: usage(100) },
    ]
    script.push(toolCall('c1'), { chunks: slowStep, delay: 50 }, text('heard you'))
    send(c, null, 'long job')
    await c.next('message.delta')
    const conversationId = conversationIdOf(c)
    c.ws.send(JSON.stringify({ type: 'interject', conversation_id: conversationId, parts: [{ type: 'text', text: 'also do X' }] }))
    await finished(c, 2)

    const rows = await rowsOf(conversationId)
    expect(rows.map(row => (isCheckpoint(row) ? 'checkpoint' : row.role))).toEqual(['user', 'assistant', 'checkpoint', 'user', 'assistant'])
    const [question, first, checkpoint, said, second] = rows
    expect(first).toMatchObject({ status: 'done', error: null })
    expect(said).toMatchObject({ parent_id: checkpoint!.id, parts: [{ type: 'text', text: 'also do X' }] })
    expect(second).toMatchObject({ parent_id: said!.id, status: 'done' })
    expect(calls.afterStep.find(input => input.stepsUsed === 2)!.pendingInterjections).toEqual([{ type: 'text', text: 'also do X' }])
    // Not delivered yet when the checkpoint was written, so it is not one of the turn's inputs there.
    expect(calls.compose[0]!.turn!.inputs.map(message => message.id)).toEqual([question!.id])

    const prompt = prompts.at(-1)!
    expect(textOf(opening(prompt))).toBe('SUMMARY')
    expect(prompt.map(textOf).join('\n')).toContain('also do X')
  })

  it('writes a checkpoint after a finished turn without continuing', async () => {
    await setup()
    behavior.afterTurn = () => 'checkpoint'
    const { c, conversationId } = await chatted()

    const rows = await rowsOf(conversationId)
    expect(rows.map(row => (isCheckpoint(row) ? 'checkpoint' : row.role))).toEqual(['user', 'assistant', 'checkpoint'])
    expect(rows[2]!.parent_id).toBe(rows[1]!.id)
    expect(await headOf(conversationId)).toBe(rows[2]!.id)
    expect(calls.compose[0]).toMatchObject({ trigger: 'auto', turn: null })
    expect(prompts.filter(() => true).length).toBeGreaterThan(0)

    // The next turn starts from the summary alone.
    behavior.afterTurn = () => 'continue'
    script.push(text('next answer'))
    send(c, conversationId, 'next question')
    await finished(c, 2)
    const prompt = prompts.at(-1)!
    expect(textOf(opening(prompt))).toBe('SUMMARY')
    expect(prompt.map(textOf).join('\n')).not.toContain('first question')
    expect(prompt.map(textOf).join('\n')).toContain('next question')
  })
})

describe('context overflow', () => {
  it('compacts and continues once when a step fails before producing anything', async () => {
    await setup()
    const c = await connect(await ensureTestUser())
    script.push(toolCall('c1'), new Error(OVERFLOW), text('recovered'))
    send(c, null, 'big task')
    await finished(c, 2)

    const rows = await rowsOf(conversationIdOf(c))
    expect(rows.map(row => (isCheckpoint(row) ? 'checkpoint' : row.role))).toEqual(['user', 'assistant', 'checkpoint', 'assistant'])
    // The failed step is dropped; the reply closes on the step that completed.
    expect(rows[1]).toMatchObject({ status: 'done', error: null, usage: { steps: [{ prompt: 100 }] } })
    expect(rows[1]!.parts.map(part => part.type)).toEqual(['tool_call', 'tool_result'])
    expect(rows[3]).toMatchObject({ status: 'done', parent_id: rows[2]!.id })
    expect(calls.compose.map(input => input.trigger)).toEqual(['overflow'])
    expect(textOf(opening(prompts.at(-1)!))).toBe('SUMMARY')
  })

  it('retries an overflow only once per turn, and marks a reply with no completed step as an error', async () => {
    await setup()
    const c = await connect(await ensureTestUser())
    script.push(new Error(OVERFLOW), new Error(OVERFLOW))
    send(c, null, 'too big')
    await finished(c, 2)

    const rows = await rowsOf(conversationIdOf(c))
    expect(rows.map(row => (isCheckpoint(row) ? 'checkpoint' : row.role))).toEqual(['user', 'assistant', 'checkpoint', 'assistant'])
    expect(rows[1]).toMatchObject({ status: 'error', error: expect.stringContaining(OVERFLOW) })
    expect(rows[3]).toMatchObject({ status: 'error', error: expect.stringContaining(OVERFLOW) })
    expect(calls.compose).toHaveLength(1)
  })

  it('treats an overflow after the step streamed output as an ordinary error', async () => {
    await setup()
    const c = await connect(await ensureTestUser())
    script.push([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'partial' },
      { type: 'error', error: new Error(OVERFLOW) },
    ])
    send(c, null, 'streams then fails')
    await finished(c, 1)

    const rows = await rowsOf(conversationIdOf(c))
    expect(rows.map(row => row.role)).toEqual(['user', 'assistant'])
    expect(rows[1]).toMatchObject({ status: 'error' })
    expect(calls.compose).toHaveLength(0)
  })
})

describe('a failed compaction', () => {
  it('writes nothing, frees the conversation and lets the turn run as it would have', async () => {
    await setup()
    const failures: unknown[] = []
    const dispose = await runInDurableObject(hubStub(), (instance: UserHub) =>
      instance.app.on('checkpoint/failed', (payload) => { failures.push(payload) }))
    behavior.beforeTurn = () => 'checkpoint'
    behavior.compose = async () => ({ error: 'summary empty' })
    try {
      const { conversationId } = await chatted()
      const rows = await rowsOf(conversationId)
      expect(rows.map(row => row.role)).toEqual(['user', 'assistant'])
      expect(rows[1]).toMatchObject({ parent_id: rows[0]!.id, status: 'done' })
      expect(failures).toEqual([{ userId: 1, conversationId, trigger: 'auto', error: 'summary empty' }])
      expect(await runInDurableObject(hubStub(), (instance: UserHub) => instance.app.hub.operations.isHeld(conversationId))).toBe(false)
    } finally {
      await runInDurableObject(hubStub(), () => dispose())
    }
  })

  it('is abandoned when the person stops it, even if the summary arrives afterwards', async () => {
    await setup()
    behavior.afterTurn = () => 'checkpoint'
    // Ignores its signal on purpose: the core must still refuse to write once stopped.
    behavior.compose = input => new Promise((resolve) => {
      input.signal.addEventListener('abort', () => resolve(draft()))
    })
    const c = await connect(await ensureTestUser())
    script.push(text('answer'))
    send(c, null, 'question')
    // Polled from here rather than signalled from inside the Durable Object, whose I/O context a
    // resolved promise would carry over to the socket below.
    while (calls.compose.length === 0) await new Promise(resolve => setTimeout(resolve, 10))
    const conversationId = conversationIdOf(c)
    c.ws.send(JSON.stringify({ type: 'stop', conversation_id: conversationId }))
    await idle()

    const rows = await rowsOf(conversationId)
    expect(rows.map(row => row.role)).toEqual(['user', 'assistant'])
    expect(await headOf(conversationId)).toBe(rows[1]!.id)
    expect(calls.compose[0]!.signal.aborted).toBe(true)
  })
})

describe('manual compaction', () => {
  it('writes a checkpoint under the head with the person’s focus', async () => {
    await setup()
    const { conversationId } = await chatted()
    const head = await headOf(conversationId)

    const outcome = await requestCheckpoint(conversationId, 'keep the API notes')
    expect(outcome).toMatchObject({ ok: true, message: { parent_id: head, parts: [{ type: 'checkpoint', content: 'SUMMARY' }] } })
    expect(calls.compose[0]).toMatchObject({ trigger: 'manual', focus: 'keep the API notes', turn: null })
    expect(textOf(calls.compose[0]!.messages.at(-1)! as Prompt[number])).toContain('first answer')
    expect(await headOf(conversationId)).toBe((outcome as { message: { id: number } }).message.id)
  })

  it('is refused while generating, while held, and while a tool waits on the person', async () => {
    await setup()
    const c = await connect(await ensureTestUser())
    script.push({ chunks: text('slow answer'), delay: 100 })
    send(c, null, 'slow')
    await c.next('message.delta')
    const conversationId = conversationIdOf(c)
    expect(await requestCheckpoint(conversationId)).toEqual({ ok: false, error: expect.any(String) })
    await finished(c, 1)

    const held = await runInDurableObject(hubStub(), (instance: UserHub) => {
      const handle = instance.app.hub.operations.acquire(conversationId)
      return instance.app.hub.compaction.requestCheckpoint({ conversationId }).finally(() => handle.release())
    })
    expect(held).toEqual({ ok: false, error: COMPACTING_MESSAGE })

    const waiting = await createConversation(db(), { user_id: 1, title: 't', provider_id: providerId!, model_id: MODEL })
    const question = await insertMessage(db(), 1, {
      conversation_id: waiting.id, parent_id: null, seq: 1, role: 'user', parts: [{ type: 'text', text: 'ask me' }],
      provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0,
    })
    const asking = await insertMessage(db(), 1, {
      conversation_id: waiting.id, parent_id: question.id, seq: 2, role: 'assistant',
      parts: [{ type: 'tool_call', id: 'ask-1', name: 'ask_user', args: { questions: [] } }],
      provider_id: providerId!, model_id: MODEL, usage: null, status: 'done', error: null, created_at: 0,
    })
    await updateConversation(db(), waiting.id, 1, { head_message_id: asking.id })
    expect(await requestCheckpoint(waiting.id)).toEqual({ ok: false, error: expect.any(String) })

    expect(calls.compose).toHaveLength(0)
    expect((await rowsOf(conversationId)).some(isCheckpoint)).toBe(false)
  })
})
