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
import { TOOL_ATTACHMENTS_KEY, type ToolResultPart } from '@/shared/parts'
import { ensureTestUser } from './auth-helper'
import { connect } from './ws-helper'

type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never
const finish = (unified: 'stop' | 'tool-calls') => ({
  type: 'finish', finishReason: { unified, raw: unified },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 }, raw: {} },
}) as StreamPart
let readRef = ''
const CALL = (): StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-call', toolCallId: 'call-read', toolName: 'read_file', input: JSON.stringify({ file: readRef }) },
  finish('tool-calls'),
]
const TEXT: StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'an otter' }, { type: 'text-end', id: 't' },
  finish('stop'),
]
const prompts: Array<Array<{ role: string, content: Array<{ type: string, text?: string }> }>> = []
let installed = false

async function seed(vision: boolean, mime: string) {
  const db = createDb(env.DB)
  await ensureTestUser(db)
  const [provider] = await db.insert(providers).values({
    user_id: 1, name: `read-image-${vision}`, api_key: await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'k'), enabled: true, created_at: 0,
  }).returning()
  const [iface] = await db.insert(providerInterfaces).values({
    provider_id: provider!.id, protocol: mime.startsWith('audio/') || mime.startsWith('video/') ? 'chat-completions' : 'responses', base_url: 'https://mock.example/v1', native_files: false, created_at: 0,
  }).returning()
  await db.update(providers).set({ default_interface_id: iface!.id }).where(eq(providers.id, provider!.id))
  await db.insert(models).values({
    provider_id: provider!.id, model_id: 'reader', enabled: true, sort: 0,
    metadata_resolved: { tool_call: true, modalities: { input: vision ? ['text', 'image', 'pdf', 'audio', 'video'] : ['text'], output: ['text'] } },
  })
  await db.update(users).set({ settings: { plugins: { workspace_files: true } } }).where(eq(users.id, 1))
  const bytes = mime === 'image/png' ? new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, vision ? 1 : 2])
    : new TextEncoder().encode(mime === 'application/pdf' ? '%PDF-1.7' : mime === 'audio/mpeg' ? 'ID3recording' : '\0\0\0\x18ftypisom')
  const key = `read-image/${crypto.randomUUID()}`
  await env.BUCKET.put(key, bytes)
  const sha256 = (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', '').slice(0, 64)
  const [attachment] = await db.insert(attachments).values({
    user_id: 1, sha256, mime, size: bytes.byteLength,
    width: 3, height: 2, r2_key: key, origin: 'upload', created_at: 0,
  }).returning()
  return { providerId: provider!.id, attachmentId: attachment!.id, prefix: sha256.slice(0, 8) }
}

async function readUpload(vision: boolean, mime = 'image/png') {
  const { providerId, attachmentId, prefix } = await seed(vision, mime)
  const c = await connect(await ensureTestUser())
  if (!installed) {
    installed = true
    await runInDurableObject(env.USER_HUB.getByName('1'), async (instance: UserHub) => {
      await instance.app.plugin({
        name: 'read-image-model', inject: ['llm'],
        apply(ctx) {
          for (const protocol of ['responses', 'chat-completions'] as const) ctx.llm.register(protocol, {
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
  readRef = `asset:${prefix}`
  prompts.length = 0
  c.ws.send(JSON.stringify({
    type: 'send', conversation_id: null, parent_id: null,
    parts: [mime.startsWith('image/') ? { type: 'image', attachment_id: attachmentId } : { type: 'file', attachment_id: attachmentId, mime }, { type: 'text', text: 'what is this?' }],
    provider_id: providerId, model_id: 'reader', tools: ['read_file'],
  }))
  const created = await c.next('message.created') as { message: { conversation_id: number } }
  await c.next('message.done')
  const rows = await listMessages(createDb(env.DB), created.message.conversation_id, 1)
  const result = rows[1]!.parts.find((part): part is ToolResultPart => part.type === 'tool_result')
  return { attachmentId, prefix, result }
}

describe('read_file on an asset reference', () => {
  it('labels the upload by asset, then delivers it in a wrapper after the tool results', async () => {
    const { attachmentId, prefix, result } = await readUpload(true)
    expect(result).toMatchObject({ content: { file: `asset:${prefix}`, mime: 'image/png', message: expect.any(String) }, attachments: [attachmentId] })
    expect(prompts[0]![0]!.content[0]).toEqual({ type: 'text', text: `[image asset:${prefix}]` })
    const second = prompts[1]!
    const toolAt = second.findIndex(message => message.role === 'tool')
    expect(second[toolAt + 1]).toMatchObject({ role: 'user', content: [
      { type: 'text', text: `<tool_attachment call_id="call-read" asset="${prefix}">` }, { type: 'file' }, { type: 'text', text: '</tool_attachment>' },
    ] })
    expect(JSON.stringify(second)).not.toContain(`${TOOL_ATTACHMENTS_KEY}`)
  })

  it.each(['application/pdf', 'audio/mpeg', 'video/mp4'])('delivers %s to a model and protocol that can read it', async mime => {
    const { prefix } = await readUpload(true, mime)
    const toolAt = prompts[1]!.findIndex(message => message.role === 'tool')
    expect(prompts[1]![toolAt + 1]).toMatchObject({ role: 'user', content: [
      { type: 'text', text: `<tool_attachment call_id="call-read" asset="${prefix}">` }, { type: 'file', mediaType: mime }, { type: 'text', text: '</tool_attachment>' },
    ] })
  })

  it('says so, without attaching anything, to a model that cannot read it', async () => {
    const { prefix, result } = await readUpload(false)
    expect(result?.content).toMatchObject({ error: 'UNSUPPORTED_FILE' })
    expect(result?.attachments).toBeUndefined()
    // The upload keeps its label; its bytes are replaced by a sentence.
    expect(prompts[0]![0]!.content.slice(0, 2)).toMatchObject([
      { type: 'text', text: `[image asset:${prefix}]` },
      { type: 'text', text: 'The current model cannot read image/png, so the file was not sent.' },
    ])
    expect(prompts[0]!.flatMap(message => message.content).some(part => part.type === 'file')).toBe(false)
  })
})
