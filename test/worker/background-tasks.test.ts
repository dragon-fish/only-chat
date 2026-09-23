import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { models, providerInterfaces, providers } from '@/server/db/schema'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import { createConversation, insertMessage, listMessages, toMessage, updateConversation } from '@/server/plugins/hub/conversations'
import { deliverTaskNotifications } from '@/server/plugins/hub/generation'
import type { TaskSettlement } from '@/server/plugins/hub/tasks'
import type { UserHub } from '@/server/index'
import type { Message } from '@/shared/models'
import type { Part } from '@/shared/parts'
import { ensureTestUser } from './auth-helper'
import { connect } from './ws-helper'

type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never

const STREAM: StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', id: 'r', modelId: 'mock', timestamp: new Date(0) },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'Here they are.' },
  { type: 'text-end', id: 't1' },
  {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 3, text: 3, reasoning: 0 },
      raw: {},
    },
  },
]

const textModel = () => new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: STREAM }) }) })

async function seedProvider(name: string): Promise<number> {
  const db = createDb(env.DB)
  await ensureTestUser(db)
  const [provider] = await db.insert(providers).values({
    user_id: 1, name, api_key: await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'k'), enabled: true, created_at: 0,
  }).returning()
  const [selected] = await db.insert(providerInterfaces).values({
    provider_id: provider!.id, protocol: 'responses', base_url: 'https://mock.example/responses-api', created_at: 0,
  }).returning()
  await db.update(providers).set({ default_interface_id: selected!.id }).where(eq(providers.id, provider!.id))
  await db.insert(models).values({ provider_id: provider!.id, model_id: 'mock-1', metadata_resolved: {}, enabled: true, sort: 0 })
  return provider!.id
}

async function installMock(): Promise<void> {
  await connect(await ensureTestUser())
  await runInDurableObject(env.USER_HUB.getByName('1'), async (instance: UserHub) => {
    await instance.app.plugin({
      name: 'mock-protocol',
      inject: ['llm'],
      apply(c) { c.llm.register('responses', { createModel: () => textModel() as never }) },
    })
  })
}

/** A chat whose head is an assistant message that called a tool; that message is the task's origin. */
async function seedChat(providerId: number, assistantParts: Part[] = [{ type: 'tool_call', id: 'call_1', name: 'generate_image', args: { prompt: 'otter' } }]) {
  const db = createDb(env.DB)
  const conversation = await createConversation(db, { user_id: 1, title: 't', provider_id: providerId, model_id: 'mock-1' })
  const user = await insertMessage(db, 1, {
    conversation_id: conversation.id, parent_id: null, seq: 1, role: 'user', parts: [{ type: 'text', text: 'draw an otter' }],
    provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0,
  })
  const origin = await insertMessage(db, 1, {
    conversation_id: conversation.id, parent_id: user.id, seq: 2, role: 'assistant', parts: assistantParts,
    provider_id: providerId, model_id: 'mock-1', usage: null, status: 'done', error: null, created_at: 0,
  })
  await updateConversation(db, conversation.id, 1, { head_message_id: origin.id })
  return { conversationId: conversation.id, origin: origin.id }
}

const settlement = (conversationId: number, origin: number, taskId = 'image_run:1'): TaskSettlement => ({
  conversation_id: conversationId,
  origin_message_id: origin,
  notification: {
    type: 'task_notification', task_id: taskId, plugin_id: 'image_generation', tool_call_id: 'call_1',
    status: 'completed', text: 'Generated 1 image(s): /artifacts/1.png',
  },
})

const settle = (s: TaskSettlement) =>
  runInDurableObject(env.USER_HUB.getByName('1'), (instance: UserHub) => instance.settleTask(1, s))

const rolesOf = async (conversationId: number) =>
  (await listMessages(createDb(env.DB), conversationId, 1)).map(row => [row.role, toMessage(row).parts.map(part => part.type).join(',')])

const queuedKeys = () => runInDurableObject(env.USER_HUB.getByName('1'), async (_instance: UserHub, state) =>
  [...(await state.storage.list({ prefix: 'task:' })).keys()])

describe('background task delivery', () => {
  it('continues after writing the notification', async () => {
    const providerId = await seedProvider('bg-continue')
    await installMock()
    const { conversationId, origin } = await seedChat(providerId)
    await settle(settlement(conversationId, origin, 'image_run:continue'))
    expect(await rolesOf(conversationId)).toEqual([
      ['user', 'text'], ['assistant', 'tool_call'], ['user', 'task_notification'], ['assistant', 'text'],
    ])
    expect(await queuedKeys()).not.toContain('task:image_run:continue')
  })

  it('delivers a task only once', async () => {
    const providerId = await seedProvider('bg-once')
    await installMock()
    const { conversationId, origin } = await seedChat(providerId)
    await settle(settlement(conversationId, origin, 'image_run:once'))
    await settle(settlement(conversationId, origin, 'image_run:once'))
    expect((await rolesOf(conversationId)).filter(([, kinds]) => kinds === 'task_notification')).toHaveLength(1)
  })

  it('does not deliver to a branch that never started the task', async () => {
    const providerId = await seedProvider('bg-branch')
    await installMock()
    const { conversationId } = await seedChat(providerId)
    await settle(settlement(conversationId, 999_999, 'image_run:branch'))
    expect(await rolesOf(conversationId)).toHaveLength(2)
    expect(await queuedKeys()).not.toContain('task:image_run:branch')
  })

  it('waits while a question to the person is open', async () => {
    const providerId = await seedProvider('bg-question')
    await installMock()
    const { conversationId, origin } = await seedChat(providerId, [{ type: 'tool_call', id: 'q', name: 'ask_user', args: { questions: [] } }])
    await settle(settlement(conversationId, origin, 'image_run:question'))
    expect(await rolesOf(conversationId)).toHaveLength(2)
    expect(await queuedKeys()).toContain('task:image_run:question')
  })

  it('holds a notification while a turn runs, then delivers it when that turn is over', async () => {
    const providerId = await seedProvider('bg-running')
    await installMock()
    const { conversationId, origin } = await seedChat(providerId)
    await runInDurableObject(env.USER_HUB.getByName('1'), async (instance: UserHub) => {
      const hub = instance.app.hub
      // Stands in for a turn in progress; only its conversation id matters to delivery.
      const running = { id: -1, conversation_id: conversationId } as Message
      await hub.trackInflight({ message: running, conversationId, controller: new AbortController(), startedAt: Date.now(), parts: [], stash: [] })
      await hub.settleTask(settlement(conversationId, origin, 'image_run:running'))
      expect(await rolesOf(conversationId)).toHaveLength(2)
      await hub.untrackInflight(running.id)
      await deliverTaskNotifications(hub, conversationId)
    })
    expect((await rolesOf(conversationId)).slice(2)).toEqual([['user', 'task_notification'], ['assistant', 'text']])
    expect(await queuedKeys()).not.toContain('task:image_run:running')
  })

  it('stops continuing after MAX_NOTIFICATION_TURNS', async () => {
    const providerId = await seedProvider('bg-cap')
    await installMock()
    const { conversationId, origin } = await seedChat(providerId)
    for (let index = 1; index <= 5; index++) await settle(settlement(conversationId, origin, `image_run:cap-${index}`))
    const roles = await rolesOf(conversationId)
    expect(roles.at(-1)).toEqual(['user', 'task_notification'])
    expect(roles.filter(([, kinds]) => kinds === 'task_notification')).toHaveLength(5)
  })
})
