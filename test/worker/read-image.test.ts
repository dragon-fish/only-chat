import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { UserHub } from '@/server/index'
import { createDb } from '@/server/db/client'
import { attachments, models, providerInterfaces, providers, users } from '@/server/db/schema'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import { listMessages } from '@/server/plugins/hub/conversations'
import type { ToolResultPart } from '@/shared/parts'
import { ensureTestUser } from './auth-helper'
import { connect } from './ws-helper'

type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never
const finish = (unified: 'stop' | 'tool-calls') => ({
  type: 'finish', finishReason: { unified, raw: unified },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 }, raw: {} },
}) as StreamPart
let readPath = ''
const CALL = (): StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-call', toolCallId: 'call-read', toolName: 'read_file', input: JSON.stringify({ path: readPath }) },
  finish('tool-calls'),
]
const TEXT: StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'an otter' }, { type: 'text-end', id: 't' },
  finish('stop'),
]
const prompts: Array<Array<{ role: string, content: Array<{ type: string, text?: string }> }>> = []
let installed = false

async function seed(vision: boolean) {
  const db = createDb(env.DB)
  await ensureTestUser(db)
  const [provider] = await db.insert(providers).values({
    user_id: 1, name: `read-image-${vision}`, api_key: await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'k'), enabled: true, created_at: 0,
  }).returning()
  const [iface] = await db.insert(providerInterfaces).values({
    provider_id: provider!.id, protocol: 'responses', base_url: 'https://mock.example/v1', native_files: false, created_at: 0,
  }).returning()
  await db.update(providers).set({ default_interface_id: iface!.id }).where(eq(providers.id, provider!.id))
  await db.insert(models).values({
    provider_id: provider!.id, model_id: 'reader', enabled: true, sort: 0,
    metadata_resolved: { tool_call: true, modalities: { input: vision ? ['text', 'image'] : ['text'], output: ['text'] } },
  })
  await db.update(users).set({ settings: { plugins: { workspace_files: true } } }).where(eq(users.id, 1))
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, vision ? 1 : 2])
  const key = `read-image/${vision}/${Date.now()}`
  await env.BUCKET.put(key, bytes)
  const [attachment] = await db.insert(attachments).values({
    user_id: 1, sha256: `read-image-${vision}-${Date.now()}`.padEnd(64, '0'), mime: 'image/png', size: bytes.byteLength,
    width: 3, height: 2, r2_key: key, origin: 'upload', created_at: 0,
  }).returning()
  return { providerId: provider!.id, attachmentId: attachment!.id }
}

async function readUploadedImage(vision: boolean) {
  const { providerId, attachmentId } = await seed(vision)
  const c = await connect(await ensureTestUser())
  if (!installed) {
    installed = true
    await runInDurableObject(env.USER_HUB.getByName('1'), async (instance: UserHub) => {
      await instance.app.plugin({
        name: 'read-image-model', inject: ['llm'],
        apply(ctx) {
          ctx.llm.register('responses', {
            createModel: () => new MockLanguageModelV4({
              doStream: async ({ prompt }) => {
                prompts.push(prompt as never)
                const answered = prompt.some(message => message.role === 'tool')
                return { stream: simulateReadableStream({ chunks: answered ? TEXT : CALL(), chunkDelayInMs: null, initialDelayInMs: null }) }
              },
            }) as never,
          })
        },
      })
    })
  }
  readPath = `/uploads/${attachmentId}.png`
  prompts.length = 0
  c.ws.send(JSON.stringify({
    type: 'send', conversation_id: null, parent_id: null,
    parts: [{ type: 'image', attachment_id: attachmentId }, { type: 'text', text: 'what is this?' }],
    provider_id: providerId, model_id: 'reader', tools: ['read_file'],
  }))
  const created = await c.next('message.created') as { message: { conversation_id: number } }
  await c.next('message.done')
  const rows = await listMessages(createDb(env.DB), created.message.conversation_id, 1)
  const result = rows[1]!.parts.find((part): part is ToolResultPart => part.type === 'tool_result')
  return { attachmentId, result }
}

describe('read_file on an image', () => {
  it('shows the image to a model that can see, after naming it in the prompt', async () => {
    const { attachmentId, result } = await readUploadedImage(true)
    expect(result).toMatchObject({
      content: { path: `/uploads/${attachmentId}.png`, mime: 'image/png', width: 3, height: 2, image: 'shown' },
      attachments: [attachmentId],
    })
    expect(prompts[0]![0]!.content[0]).toEqual({ type: 'text', text: `[image: /uploads/${attachmentId}.png]` })
    const second = prompts[1]!
    const toolAt = second.findIndex(message => message.role === 'tool')
    expect(second[toolAt + 1]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'Image returned by read_file:' }, { type: 'file' }] })
  })

  it('says so, without attaching anything, to a model that cannot', async () => {
    const { result } = await readUploadedImage(false)
    expect(result?.content).toMatchObject({ image: 'unsupported', message: 'This model cannot view images.' })
    expect(result?.attachments).toBeUndefined()
  })
})
