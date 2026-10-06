import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { attachments, models, providerInterfaces, providers } from '@/server/db/schema'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import { createConversation, getConversation, insertMessage, listMessages, toMessage, updateConversation } from '@/server/plugins/hub/conversations'
import type { OperationHandle } from '@/server/plugins/hub/operations'
import type { CheckpointCommittedPayload } from '@/server/plugins/hub/checkpoint-writer'
import type { TaskSettlement } from '@/server/plugins/hub/tasks'
import type { UserHub } from '@/server/index'
import type { CheckpointPart, Part } from '@/shared/parts'
import type { WsEvent } from '@/shared/ws'
import { ensureTestUser } from './auth-helper'
import { connect, type WsHarness } from './ws-helper'

type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never
type Prompt = Parameters<MockLanguageModelV4['doStream']>[0]['prompt']

const REPLY: StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', id: 'r', modelId: 'mock', timestamp: new Date(0) },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'reply' },
  { type: 'text-end', id: 't1' },
  {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 }, raw: {} },
  },
]

/** Every prompt the model was sent, across all tests of this file. */
const prompts: Prompt[] = []
let installed = false

const hubStub = () => env.USER_HUB.getByName('1')

async function seedProvider(): Promise<number> {
  const db = createDb(env.DB)
  await ensureTestUser(db)
  const [provider] = await db.insert(providers).values({
    user_id: 1, name: `checkpoint-${crypto.randomUUID()}`, api_key: await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'k'), enabled: true, created_at: 0,
  }).returning()
  const [selected] = await db.insert(providerInterfaces).values({
    provider_id: provider!.id, protocol: 'responses', base_url: 'https://mock.example/responses-api', created_at: 0,
  }).returning()
  await db.update(providers).set({ default_interface_id: selected!.id }).where(eq(providers.id, provider!.id))
  await db.insert(models).values({ provider_id: provider!.id, model_id: 'mock-1', metadata_resolved: {}, enabled: true, sort: 0 })
  if (!installed) {
    installed = true
    await connect(await ensureTestUser())
    await runInDurableObject(hubStub(), async (instance: UserHub) => {
      await instance.app.plugin({
        name: 'checkpoint-mock',
        inject: ['llm'],
        apply(c) {
          c.llm.register('responses', {
            createModel: () => new MockLanguageModelV4({
              doStream: async ({ prompt }) => {
                prompts.push(prompt)
                return { stream: simulateReadableStream({ chunks: REPLY, chunkDelayInMs: null, initialDelayInMs: null }) }
              },
            }) as never,
          })
        },
      })
    })
  }
  return provider!.id
}

async function seedAttachment(): Promise<number> {
  const [row] = await createDb(env.DB).insert(attachments).values({
    user_id: 1, sha256: crypto.randomUUID().replaceAll('-', ''), mime: 'image/png', size: 1, r2_key: crypto.randomUUID(), origin: 'upload', created_at: 0,
  }).returning()
  return row!.id
}

/** user → assistant, head on the assistant. */
async function seedChat(providerId: number, options: { userParts?: Part[], assistantParts?: Part[] } = {}) {
  const db = createDb(env.DB)
  const conversation = await createConversation(db, { user_id: 1, title: 't', provider_id: providerId, model_id: 'mock-1' })
  const user = await insertMessage(db, 1, {
    conversation_id: conversation.id, parent_id: null, seq: 1, role: 'user', parts: options.userParts ?? [{ type: 'text', text: 'OLD QUESTION' }],
    provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0,
  })
  const assistant = await insertMessage(db, 1, {
    conversation_id: conversation.id, parent_id: user.id, seq: 2, role: 'assistant', parts: options.assistantParts ?? [{ type: 'text', text: 'OLD ANSWER' }],
    provider_id: providerId, model_id: 'mock-1', usage: null, status: 'done', error: null, created_at: 0,
  })
  await updateConversation(db, conversation.id, 1, { head_message_id: assistant.id })
  return { conversationId: conversation.id, userId: user.id, assistantId: assistant.id }
}

function checkpoint(content = 'SUMMARY', attachmentIds: number[] = []): CheckpointPart {
  return { type: 'checkpoint', plugin: 'context_compaction', content, attachments: attachmentIds, contributors: [], data: { trigger: 'manual' } }
}

const commit = (conversationId: number, expectedHead: number, part = checkpoint()) =>
  runInDurableObject(hubStub(), (instance: UserHub) =>
    instance.app.hub.checkpoints.commit({ conversationId, expectedHead, part, usage: { prompt: 10, completion: 2 } }))

const rowsOf = (conversationId: number) => listMessages(createDb(env.DB), conversationId, 1)
const headOf = async (conversationId: number) => (await getConversation(createDb(env.DB), conversationId, 1))!.head_message_id

async function errorAfter(c: WsHarness, command: object): Promise<string> {
  const count = c.events.filter(event => event.type === 'error').length + 1
  c.ws.send(JSON.stringify(command))
  return (await c.nextAfter('error', count) as Extract<WsEvent, { type: 'error' }>).message
}

describe('checkpoint commit', () => {
  it('writes the checkpoint under the head, moves the head onto it, and tells every device', async () => {
    const providerId = await seedProvider()
    const image = await seedAttachment()
    const { conversationId, assistantId } = await seedChat(providerId, { userParts: [{ type: 'text', text: 'look' }, { type: 'image', attachment_id: image }] })
    const c = await connect(await ensureTestUser())
    await c.next('snapshot')
    const committed: CheckpointCommittedPayload[] = []
    const dispose = await runInDurableObject(hubStub(), (instance: UserHub) =>
      instance.app.on('checkpoint/committed', async (payload) => { committed.push(payload) }))

    const part = checkpoint('SUMMARY', [image])
    const message = await commit(conversationId, assistantId, part)
    await runInDurableObject(hubStub(), () => dispose())

    expect(message).toMatchObject({ parent_id: assistantId, role: 'assistant', status: 'done', parts: [part], usage: { prompt: 10 } })
    expect(await headOf(conversationId)).toBe(message!.id)
    expect((await rowsOf(conversationId)).at(-1)).toMatchObject({ id: message!.id, parts: [part] })
    expect(await c.next('message.created')).toMatchObject({ message: { id: message!.id, parts: [part] } })
    expect(await c.next('head.changed')).toEqual({ type: 'head.changed', conversation_id: conversationId, message_id: message!.id })
    expect(committed).toEqual([{ userId: 1, conversationId, part, message: expect.objectContaining({ id: message!.id }) }])
  })

  it('writes nothing when the head moved', async () => {
    const providerId = await seedProvider()
    const { conversationId, userId, assistantId } = await seedChat(providerId)
    expect(await commit(conversationId, userId)).toBeNull()
    expect(await rowsOf(conversationId)).toHaveLength(2)
    expect(await headOf(conversationId)).toBe(assistantId)
  })

  it('refuses an attachment the path never showed', async () => {
    const providerId = await seedProvider()
    const elsewhere = await seedAttachment()
    const { conversationId, assistantId } = await seedChat(providerId)
    await expect(commit(conversationId, assistantId, checkpoint('S', [elsewhere]))).rejects.toThrow(`attachment ${elsewhere} not found`)
    expect(await rowsOf(conversationId)).toHaveLength(2)
  })

  it('refuses while a question to the person is unanswered', async () => {
    const providerId = await seedProvider()
    const { conversationId, assistantId } = await seedChat(providerId, {
      assistantParts: [{ type: 'tool_call', id: 'q', name: 'ask_user', args: { questions: [] } }],
    })
    await expect(commit(conversationId, assistantId)).rejects.toThrow('tool calls are waiting for an answer')
    expect(await rowsOf(conversationId)).toHaveLength(2)
  })
})

describe('checkpoint compose', () => {
  it('collects blocks in plugin manifest order, whatever order they arrive in, with each contributor once', async () => {
    const providerId = await seedProvider()
    const { conversationId } = await seedChat(providerId)
    const result = await runInDurableObject(hubStub(), async (instance: UserHub) => {
      const hub = instance.app.hub
      const listeners = [
        instance.app.on('checkpoint/compose', async (payload) => {
          await new Promise(resolve => setTimeout(resolve, 5))
          payload.blocks.push({ pluginId: 'workspace_files', text: 'files' })
        }),
        instance.app.on('checkpoint/compose', async (payload) => {
          payload.blocks.push({ pluginId: 'memory', text: 'memory one' }, { pluginId: 'ask_user', text: 'asked' })
          payload.blocks.push({ pluginId: 'memory', text: 'memory two' })
        }),
      ]
      try {
        const path = (await listMessages(hub.db, conversationId, 1)).map(row => toMessage(row))
        return await hub.checkpoints.compose({ conversationId, projectId: null, toolIds: [], path })
      } finally {
        for (const dispose of listeners) dispose()
      }
    })
    expect(result.blocks.map(block => block.text)).toEqual(['asked', 'files', 'memory one', 'memory two'])
    expect(result.contributors).toEqual(['ask_user', 'workspace_files', 'memory'])
  })
})

describe('after a checkpoint', () => {
  it('replays the checkpoint content in place of everything before it', async () => {
    const providerId = await seedProvider()
    const { conversationId, assistantId } = await seedChat(providerId)
    const cp = await commit(conversationId, assistantId, checkpoint('THE SUMMARY'))
    const c = await connect(await ensureTestUser())
    const before = prompts.length
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: conversationId, parent_id: cp!.id, parts: [{ type: 'text', text: 'NEW QUESTION' }],
      provider_id: providerId, model_id: 'mock-1',
    }))
    await c.next('message.done')
    const sent = JSON.stringify(prompts.slice(before))
    expect(sent).toContain('THE SUMMARY')
    expect(sent).toContain('NEW QUESTION')
    expect(sent).not.toContain('OLD QUESTION')
    expect(sent).not.toContain('OLD ANSWER')
  })

  it('refuses to regenerate or edit a checkpoint', async () => {
    const providerId = await seedProvider()
    const { conversationId, assistantId } = await seedChat(providerId)
    const cp = await commit(conversationId, assistantId)
    const c = await connect(await ensureTestUser())
    expect(await errorAfter(c, { type: 'regenerate', message_id: cp!.id })).toBe('a checkpoint cannot be regenerated')
    expect(await errorAfter(c, { type: 'edit', message_id: cp!.id, parts: [{ type: 'text', text: 'x' }] })).toBe('not a user message')
    expect(await rowsOf(conversationId)).toHaveLength(3)
  })

  it('refuses a checkpoint part from a client', async () => {
    const providerId = await seedProvider()
    const { conversationId, userId, assistantId } = await seedChat(providerId)
    const c = await connect(await ensureTestUser())
    expect(await errorAfter(c, {
      type: 'send', conversation_id: conversationId, parent_id: assistantId, parts: [checkpoint()], provider_id: providerId, model_id: 'mock-1',
    })).toBe('invalid command')
    expect(await errorAfter(c, { type: 'edit', message_id: userId, parts: [checkpoint()] })).toBe('invalid command')
    expect(await rowsOf(conversationId)).toHaveLength(2)
  })

  it('does not take a checkpoint under a tool message for its continuation', async () => {
    const providerId = await seedProvider()
    const { conversationId, assistantId } = await seedChat(providerId, {
      assistantParts: [
        { type: 'tool_call', id: 'c1', name: 'lookup', args: {} },
        { type: 'tool_result', call_id: 'c1', name: 'lookup', content: { ok: true } },
      ],
    })
    const cp = await commit(conversationId, assistantId)
    // Back on the tool message, as if the person had switched to it.
    await updateConversation(createDb(env.DB), conversationId, 1, { head_message_id: assistantId })
    const c = await connect(await ensureTestUser())
    c.ws.send(JSON.stringify({ type: 'tool.continue', request_id: 'continue', message_id: assistantId }))
    await c.next('message.done')

    const children = (await rowsOf(conversationId)).filter(row => row.parent_id === assistantId)
    expect(children.map(row => toMessage(row).parts[0]?.type)).toEqual(['checkpoint', 'text'])
    expect(await headOf(conversationId)).toBe(children[1]!.id)
    expect(children[0]!.id).toBe(cp!.id)
  })

  it('is copied as-is by a fork', async () => {
    const providerId = await seedProvider()
    const { conversationId, assistantId } = await seedChat(providerId)
    const part = checkpoint('FORKED SUMMARY')
    const cp = await commit(conversationId, assistantId, part)
    const c = await connect(await ensureTestUser())
    c.ws.send(JSON.stringify({ type: 'conversation.fork', request_id: 'fork', conversation_id: conversationId, message_id: cp!.id }))
    const forked = await c.next('conversation.forked') as Extract<WsEvent, { type: 'conversation.forked' }>
    const rows = await rowsOf(forked.conversation_id)
    expect(rows.map(row => row.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(rows.at(-1)!.parts).toEqual([part])
    expect(await headOf(forked.conversation_id)).toBe(rows.at(-1)!.id)
  })
})

describe('conversation operation lock', () => {
  let handle: OperationHandle | undefined

  it('refuses commands that move the head, holds notifications, and delivers them on release', async () => {
    const providerId = await seedProvider()
    const { conversationId, userId, assistantId } = await seedChat(providerId, {
      assistantParts: [{ type: 'tool_call', id: 'call_1', name: 'generate_image', args: {} }, { type: 'tool_result', call_id: 'call_1', name: 'generate_image', content: { started: true } }],
    })
    await runInDurableObject(hubStub(), (instance: UserHub) => { handle = instance.app.hub.operations.acquire(conversationId) })
    const c = await connect(await ensureTestUser())
    expect(await c.next('snapshot')).toMatchObject({ compacting: [conversationId] })

    const send = { type: 'send', conversation_id: conversationId, parent_id: assistantId, parts: [{ type: 'text', text: 'hi' }], provider_id: providerId, model_id: 'mock-1' }
    expect(await errorAfter(c, send)).toBe('正在压缩上下文')
    expect(await errorAfter(c, { type: 'edit', message_id: userId, parts: [{ type: 'text', text: 'x' }] })).toBe('正在压缩上下文')
    expect(await errorAfter(c, { type: 'regenerate', message_id: assistantId })).toBe('正在压缩上下文')
    expect(await errorAfter(c, { type: 'switch_head', conversation_id: conversationId, message_id: userId })).toBe('正在压缩上下文')
    expect(await errorAfter(c, { type: 'conversation.delete', conversation_id: conversationId })).toBe('正在压缩上下文')
    await expect(runInDurableObject(hubStub(), (instance: UserHub) => instance.app.hub.operations.run(conversationId, async () => 'second')))
      .rejects.toThrow('正在压缩上下文')

    const settlement: TaskSettlement = {
      conversation_id: conversationId, origin_message_id: assistantId,
      notification: { type: 'task_notification', task_id: `lock:${conversationId}`, plugin_id: 'image_generation', tool_call_id: 'call_1', status: 'completed', text: 'done' },
    }
    await runInDurableObject(hubStub(), (instance: UserHub) => instance.app.hub.settleTask(settlement))
    expect(await rowsOf(conversationId)).toHaveLength(2)

    await runInDurableObject(hubStub(), () => handle!.release())
    const roles = (await rowsOf(conversationId)).map(row => [row.role, row.parts.map(part => part.type).join(',')])
    expect(roles.slice(2)).toEqual([['user', 'task_notification'], ['assistant', 'text']])
    expect(await headOf(conversationId)).not.toBe(assistantId)
  })

  it('announces taking and releasing the lock to connected clients', async () => {
    const providerId = await seedProvider()
    const { conversationId } = await seedChat(providerId)
    const c = await connect(await ensureTestUser())
    await c.next('snapshot')
    const mine = () => c.events.filter(event => event.type === 'conversation.compacting' && event.conversation_id === conversationId)
    let held: OperationHandle | undefined
    await runInDurableObject(hubStub(), (instance: UserHub) => { held = instance.app.hub.operations.acquire(conversationId) })
    await expect.poll(mine).toEqual([{ type: 'conversation.compacting', conversation_id: conversationId, compacting: true }])
    await runInDurableObject(hubStub(), () => held!.release())
    await expect.poll(() => mine().map(event => event.type === 'conversation.compacting' && event.compacting)).toEqual([true, false])
  })

  it('is aborted and released by stop, writing nothing', async () => {
    const providerId = await seedProvider()
    const { conversationId, assistantId } = await seedChat(providerId)
    // Started and checked inside one call: two separate runInDurableObject calls are not ordered.
    let outcome!: Promise<string>
    await runInDurableObject(hubStub(), (instance: UserHub) => {
      outcome = instance.app.hub.operations.run(conversationId, signal => new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error(`aborted: ${String(signal.reason)}`)))
      })).catch((error: Error) => error.message)
      // The lock is taken synchronously by `run`, before its first await.
      expect(instance.app.hub.operations.isHeld(conversationId)).toBe(true)
    })
    const c = await connect(await ensureTestUser())
    c.ws.send(JSON.stringify({ type: 'stop', conversation_id: conversationId }))
    expect(await outcome).toBe('aborted: user stopped')
    await runInDurableObject(hubStub(), (instance: UserHub) => expect(instance.app.hub.operations.isHeld(conversationId)).toBe(false))
    expect(await rowsOf(conversationId)).toHaveLength(2)
    expect(await headOf(conversationId)).toBe(assistantId)
  })
})
