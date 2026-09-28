import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import type { UserHub } from '@/server/index'
import { createDb } from '@/server/db/client'
import { attachments, models, providerInterfaces, providers, users } from '@/server/db/schema'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import { listMessages } from '@/server/plugins/hub/conversations'
import { stripToolAttachments, TOOL_ATTACHMENTS_KEY } from '@/shared/parts'
import { ensureTestUser } from './auth-helper'
import { connect } from './ws-helper'

type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never
const finish = (unified: 'stop' | 'tool-calls') => ({
  type: 'finish', finishReason: { unified, raw: unified },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 }, raw: {} },
}) as StreamPart
const CALL: StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  // Two in one step: their files follow the whole batch of results, in one message.
  { type: 'tool-call', toolCallId: 'call-peek', toolName: 'peek', input: '{}' },
  { type: 'tool-call', toolCallId: 'call-peek-2', toolName: 'peek', input: '{}' },
  finish('tool-calls'),
]
const TEXT: StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'an otter' }, { type: 'text-end', id: 't' },
  finish('stop'),
]

describe('an image a tool shows the model', () => {
  it('reaches it mid-turn exactly as the next turn rebuilds it', async () => {
    const db = createDb(env.DB)
    await ensureTestUser(db)
    const [provider] = await db.insert(providers).values({
      user_id: 1, name: 'tool-images', api_key: await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'k'), enabled: true, created_at: 0,
    }).returning()
    const [iface] = await db.insert(providerInterfaces).values({
      provider_id: provider!.id, protocol: 'responses', base_url: 'https://mock.example/v1', native_files: false, created_at: 0,
    }).returning()
    await db.update(providers).set({ default_interface_id: iface!.id }).where(eq(providers.id, provider!.id))
    await db.insert(models).values({
      provider_id: provider!.id, model_id: 'vision', enabled: true, sort: 0,
      metadata_resolved: { tool_call: true, modalities: { input: ['text', 'image'], output: ['text'] } },
    })
    await db.update(users).set({ settings: { plugins: { ask_user: true } } }).where(eq(users.id, 1))
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7, 7])
    const key = `tool-images/${Date.now()}`
    await env.BUCKET.put(key, bytes)
    const [attachment] = await db.insert(attachments).values({
      user_id: 1, sha256: (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', '').slice(0, 64), mime: 'image/png', size: bytes.byteLength,
      width: 1, height: 1, r2_key: key, origin: 'generated', created_at: 0,
    }).returning()

    const prompts: unknown[][] = []
    const c = await connect(await ensureTestUser())
    await runInDurableObject(env.USER_HUB.getByName('1'), async (instance: UserHub) => {
      instance.app.tools.register('ask_user', 'peek', () => ({
        description: 'peek', inputSchema: z.object({}),
        execute: async () => ({ path: '/uploads/1.png', [TOOL_ATTACHMENTS_KEY]: [attachment!.id] }),
        toModelOutput: ({ output }: { output: unknown }) => ({ type: 'json' as const, value: stripToolAttachments(output) as never }),
      }))
      await instance.app.plugin({
        name: 'tool-images-model', inject: ['llm'],
        apply(ctx) {
          ctx.llm.register('responses', {
            createModel: () => new MockLanguageModelV4({
              doStream: async ({ prompt }) => {
                prompts.push(prompt as unknown[])
                return { stream: simulateReadableStream({ chunks: prompts.length === 1 ? CALL : TEXT, chunkDelayInMs: null, initialDelayInMs: null }) }
              },
            }) as never,
          })
        },
      })
    })

    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'what is it' }],
      provider_id: provider!.id, model_id: 'vision', tools: ['peek'],
    }))
    const created = await c.next('message.created') as { message: { conversation_id: number } }
    await c.next('message.done')
    const conversationId = created.message.conversation_id
    const stored = (await listMessages(db, conversationId, 1))[1]!.parts.find(part => part.type === 'tool_result')
    expect(stored).toEqual({ type: 'tool_result', call_id: 'call-peek', name: 'peek', content: { path: '/uploads/1.png' }, attachments: [attachment!.id] })

    const midTurn = prompts[1] as Array<{ role: string, content: Array<{ type: string, text?: string }> }>
    const toolAt = midTurn.findIndex(m => m.role === 'tool')
    const asset = attachment!.sha256.slice(0, 8)
    expect(midTurn[toolAt + 1]).toMatchObject({ role: 'user', content: [
      { type: 'text', text: `<tool_attachment call_id="call-peek" asset="${asset}">` },
      { type: 'file', mediaType: 'image/png' },
      { type: 'text', text: '</tool_attachment>' },
      { type: 'text', text: `<tool_attachment call_id="call-peek-2" asset="${asset}">` },
      { type: 'file', mediaType: 'image/png' },
      { type: 'text', text: '</tool_attachment>' },
    ] })
    expect(JSON.stringify(midTurn[toolAt])).not.toContain(TOOL_ATTACHMENTS_KEY)

    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: conversationId, parent_id: null, parts: [{ type: 'text', text: 'and now?' }],
      provider_id: provider!.id, model_id: 'vision',
    }))
    await c.nextAfter('message.done', 2)
    expect(prompts[2]!.slice(0, midTurn.length)).toEqual(midTurn)
  })
})
