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
import type { GenerationTurn } from '@/server/plugins/hub/generation-turn'
import type { UserHub } from '@/server/index'
import { ensureTestUser } from './auth-helper'
import { connect } from './ws-helper'

type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never

const TEXT_STREAM = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'ok' },
  { type: 'text-end', id: 't1' },
  {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 }, raw: {} },
  },
] as StreamPart[]

let failNext = false
const settled: GenerationTurn[] = []
const toolTurns: Map<string, unknown>[] = []
let installed = false

async function setup(): Promise<number> {
  const db = createDb(env.DB)
  await ensureTestUser(db)
  const [provider] = await db.insert(providers).values({
    user_id: 1, name: 'settled', api_key: await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'k'), enabled: true, created_at: 0,
  }).returning()
  const [iface] = await db.insert(providerInterfaces).values({
    provider_id: provider!.id, protocol: 'responses', base_url: 'https://mock.example/v1', native_files: false, created_at: 0,
  }).returning()
  await db.update(providers).set({ default_interface_id: iface!.id }).where(eq(providers.id, provider!.id))
  await db.insert(models).values({ provider_id: provider!.id, model_id: 'settled-model', metadata_resolved: { tool_call: true }, enabled: true, sort: 0 })
  await db.update(users).set({ settings: { plugins: { settled_probe: true } } }).where(eq(users.id, 1))

  await connect(await ensureTestUser())
  if (!installed) {
    installed = true
    await runInDurableObject(env.USER_HUB.getByName('1'), async (instance: UserHub) => {
      await instance.app.plugin({
        name: 'settled-probe',
        inject: ['tools', 'llm'],
        apply(ctx) {
          ctx.on('generation/settled', async (turn) => { settled.push(turn) })
          ctx.tools.register('settled_probe', 'settled_probe_tool', (context) => {
            toolTurns.push(context.turn)
            return tool({ description: 'probe', inputSchema: z.object({}) })
          })
          ctx.llm.register('responses', {
            createModel: () => new MockLanguageModelV4({
              doStream: async () => {
                if (failNext) throw new Error('upstream down')
                return { stream: simulateReadableStream({ chunks: TEXT_STREAM, chunkDelayInMs: null, initialDelayInMs: null }) }
              },
            }) as never,
          })
        },
      })
    })
  }
  return provider!.id
}

async function send(providerId: number) {
  const c = await connect(await ensureTestUser())
  c.ws.send(JSON.stringify({
    type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
    provider_id: providerId, model_id: 'settled-model', tools: ['settled_probe_tool'],
  }))
  return c.next('message.done') as Promise<{ status: string }>
}

describe('generation/settled', () => {
  it('fires once per generation with the state its tools were given, whether it succeeded or failed', async () => {
    const providerId = await setup()
    settled.length = 0
    toolTurns.length = 0

    failNext = false
    expect((await send(providerId)).status).toBe('done')
    failNext = true
    expect((await send(providerId)).status).toBe('error')
    failNext = false

    expect(settled).toHaveLength(2)
    // The same map, so a plugin can release what its tools opened during that turn.
    expect(settled.map(turn => turn.state)).toEqual(toolTurns)
    expect(settled[0]!.state).toBe(toolTurns[0])
  })
})
