import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { tool } from 'ai'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createDb } from '@/server/db/client'
import { models, providerInterfaces, providers, users } from '@/server/db/schema'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import type { ToolContext } from '@/server/plugins/tools'
import type { UserHub } from '@/server/index'
import { ensureTestUser as seedTestUser } from './auth-helper'
import { connect } from './ws-helper'

type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never

const TEXT_STREAM = [
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', id: 'r', modelId: 'mock', timestamp: new Date(0) },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'ok' },
  { type: 'text-end', id: 't1' },
  {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 }, raw: {} },
  },
] as StreamPart[]

async function seedToolProvider(): Promise<number> {
  const db = createDb(env.DB)
  await seedTestUser(db)
  const [provider] = await db.insert(providers).values({
    user_id: 1, name: 'runtime', api_key: await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'k'), enabled: true, created_at: 0,
  }).returning()
  const [iface] = await db.insert(providerInterfaces).values({
    provider_id: provider!.id, protocol: 'responses', base_url: 'https://mock.example/v1', native_files: false, created_at: 0,
  }).returning()
  await db.update(providers).set({ default_interface_id: iface!.id }).where(eq(providers.id, provider!.id))
  await db.insert(models).values({ provider_id: provider!.id, model_id: 'tool-model', metadata_resolved: { tool_call: true }, enabled: true, sort: 0 })
  await db.update(users).set({ settings: { plugins: { probe: true } } }).where(eq(users.id, 1))
  return provider!.id
}

/**
 * Registers a tool that records the runtime it was handed, alongside a model that just answers.
 *
 * The Durable Object outlives a single test, so the plugin is installed once and the recording array
 * is redirected per test — registering twice would throw on the duplicate tool id.
 */
let probeSeen: ToolContext[] = []
let probeInstalled = false

async function installProbe(seen: ToolContext[]) {
  probeSeen = seen
  await connect(await seedTestUser())
  if (probeInstalled) return
  probeInstalled = true
  await runInDurableObject(env.USER_HUB.getByName(String(1)), async (instance: UserHub) => {
    await instance.app.plugin({
      name: 'probe-tool',
      inject: ['tools', 'llm'],
      apply(ctx) {
        ctx.tools.register('probe', 'probe_tool', (context) => {
          probeSeen.push(context)
          return tool({ description: 'probe', inputSchema: z.object({}) })
        })
        ctx.llm.register('responses', {
          createModel: () => new MockLanguageModelV4({
            doStream: async () => ({ stream: simulateReadableStream({ chunks: TEXT_STREAM, chunkDelayInMs: null, initialDelayInMs: null }) }),
          }) as never,
        })
      },
    })
  })
}

describe('tool runtime context', () => {
  it('builds each tool against the generation it belongs to', async () => {
    const providerId = await seedToolProvider()
    const seen: ToolContext[] = []
    await installProbe(seen)

    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
      provider_id: providerId, model_id: 'tool-model', tools: ['probe_tool'],
    }))
    await c.next('message.done')

    const created = c.events.filter(e => e.type === 'message.created') as Array<{ message: { id: number, conversation_id: number, role: string } }>
    const assistant = created.find(event => event.message.role === 'assistant')!.message

    expect(seen).toHaveLength(1)
    const runtime = seen[0]!
    expect(runtime.userId).toBe(1)
    expect(runtime.conversationId).toBe(assistant.conversation_id)
    expect(runtime.projectId).toBeNull()
    // The reason tools are built after the shell: this id does not exist any earlier.
    expect(runtime.assistantMessageId).toBe(assistant.id)
    expect(runtime.signal.aborted).toBe(false)
    expect(runtime.db).toBeDefined()
    expect(runtime.assets).toBeDefined()
  })

  it('never builds a tool whose plugin is globally disabled', async () => {
    const providerId = await seedToolProvider()
    const seen: ToolContext[] = []
    await installProbe(seen)
    await createDb(env.DB).update(users).set({ settings: { plugins: { probe: false } } }).where(eq(users.id, 1))

    const c = await connect(await seedTestUser())
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
      provider_id: providerId, model_id: 'tool-model', tools: ['probe_tool'],
    }))
    await c.next('message.done')
    expect(seen).toEqual([])
  })
})
