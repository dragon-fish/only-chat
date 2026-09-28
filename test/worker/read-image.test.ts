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
let analyze = false
let analysisPrompt: unknown
let analysisQuestion: string | undefined = '转写所有文字'
let analysisFailure = false
const CALL = (): StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-call', toolCallId: 'call-read', toolName: analyze ? 'analyze_file' : 'read_file', input: JSON.stringify({ path: readPath, ...(analyze && analysisQuestion ? { question: analysisQuestion } : {}) }) },
  finish('tool-calls'),
]
const TEXT: StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'an otter' }, { type: 'text-end', id: 't' },
  finish('stop'),
]
const prompts: Array<Array<{ role: string, content: Array<{ type: string, text?: string }> }>> = []
let installed = false

async function seed(vision: boolean, service: boolean, mime: string) {
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
  await db.insert(models).values({ provider_id: provider!.id, model_id: 'analyst', enabled: true, sort: 1, metadata_resolved: { modalities: { input: ['text', 'image', 'pdf', 'audio', 'video'], output: ['text'] } } })
  await db.update(users).set({ settings: { plugins: { workspace_files: true }, service_models: { file_understanding: service ? { provider_id: provider!.id, model_id: 'analyst' } : null }, service_prompts: { file_understanding: 'Describe every detail. 原文保持原样。' } } }).where(eq(users.id, 1))
  const bytes = mime === 'image/png' ? new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, vision ? 1 : 2])
    : new TextEncoder().encode(mime === 'application/pdf' ? '%PDF-1.7' : mime === 'audio/mpeg' ? 'ID3recording' : '\0\0\0\x18ftypisom')
  const key = `read-image/${crypto.randomUUID()}`
  await env.BUCKET.put(key, bytes)
  const [attachment] = await db.insert(attachments).values({
    user_id: 1, sha256: crypto.randomUUID().padEnd(64, '0'), mime, size: bytes.byteLength,
    width: 3, height: 2, r2_key: key, origin: 'upload', created_at: 0,
  }).returning()
  return { providerId: provider!.id, attachmentId: attachment!.id }
}

async function readUploadedImage(vision: boolean, service = false, mime = 'image/png') {
  const { providerId, attachmentId } = await seed(vision, service, mime)
  const c = await connect(await ensureTestUser())
  if (!installed) {
    installed = true
    await runInDurableObject(env.USER_HUB.getByName('1'), async (instance: UserHub) => {
      await instance.app.plugin({
        name: 'read-image-model', inject: ['llm'],
        apply(ctx) {
          for (const protocol of ['responses', 'chat-completions'] as const) ctx.llm.register(protocol, {
            createModel: () => new MockLanguageModelV4({
              doGenerate: async ({ prompt }) => {
                analysisPrompt = prompt
                if (analysisFailure) throw new Error('analysis provider failed')
                return { content: [{ type: 'text', text: '详细描述：图片文字为“你好”。' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] }
              },
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
  const ext = mime === 'application/pdf' ? 'pdf' : mime === 'audio/mpeg' ? 'mp3' : mime === 'video/mp4' ? 'mp4' : 'png'
  readPath = `/uploads/${attachmentId}.${ext}`
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
  return { attachmentId, result }
}

describe('read_file on an image', () => {
  it('shows the image to a model that can see, after naming it in the prompt', async () => {
    const { attachmentId, result } = await readUploadedImage(true)
    expect(result).toMatchObject({
      content: { request_id: expect.any(String), message: expect.any(String) },
      attachments: [attachmentId],
    })
    expect(prompts[0]![0]!.content[0]).toEqual({ type: 'text', text: `[image: /uploads/${attachmentId}.png]` })
    const second = prompts[1]!
    const toolAt = second.findIndex(message => message.role === 'tool')
    expect(second[toolAt + 1]).toMatchObject({ role: 'user', content: [{ type: 'text', text: `<read_file_result id="${(result?.content as { request_id: string }).request_id}">` }, { type: 'file' }, { type: 'text', text: '</read_file_result>' }] })
  })

  it.each(['application/pdf', 'audio/mpeg', 'video/mp4'])('reads %s as a user file with a matching receipt', async mime => {
    const { result } = await readUploadedImage(true, false, mime)
    const id = (result?.content as { request_id: string }).request_id
    expect(id).toEqual(expect.any(String))
    const toolAt = prompts[1]!.findIndex(message => message.role === 'tool')
    expect(prompts[1]![toolAt + 1]).toMatchObject({ role: 'user', content: [
      { type: 'text', text: `<read_file_result id="${id}">` }, { type: 'file', mediaType: mime }, { type: 'text', text: '</read_file_result>' },
    ] })
    expect(JSON.stringify(prompts[1]![toolAt])).not.toContain('__attachments')
  })

  it('says so, without attaching anything, to a model that cannot', async () => {
    const { result } = await readUploadedImage(false)
    expect(result?.content).toMatchObject({ error: 'UNSUPPORTED_FILE' })
    expect(result?.attachments).toBeUndefined()
    expect(prompts[0]!.flatMap(message => message.content).some(part => part.type === 'file')).toBe(false)
  })
})


describe('analyze_file', () => {
  it.each(['image/png', 'application/pdf', 'audio/mpeg', 'video/mp4'])('delegates %s without sending bytes to the text-only main model', async mime => {
    analyze = true
    const { result } = await readUploadedImage(false, true, mime)
    expect(result?.content).toMatchObject({ path: readPath, mime, text: '详细描述：图片文字为“你好”。', truncated: false })
    expect(analysisPrompt).toMatchObject([
      { role: 'system', content: 'Describe every detail. 原文保持原样。' },
      { role: 'user', content: [{ type: 'file', mediaType: mime }, { type: 'text', text: '转写所有文字' }] },
    ])
    expect(prompts.flatMap(messages => messages.flatMap(message => message.content)).some(part => part.type === 'file')).toBe(false)
    analyze = false
  })

  it('accepts an omitted question', async () => {
    analyze = true
    analysisQuestion = undefined
    const { result } = await readUploadedImage(false, true)
    expect(result?.content).toHaveProperty('text')
    expect((analysisPrompt as Array<{ content: unknown[] }>)[1]!.content).toHaveLength(1)
    analysisQuestion = '转写所有文字'
    analyze = false
  })

  it('returns a service error when no auxiliary model is configured', async () => {
    analyze = true
    const { result } = await readUploadedImage(false)
    expect(result?.content).toMatchObject({ error: 'SERVICE_UNAVAILABLE' })
    analyze = false
  })

  it('reports provider failures instead of returning a fabricated description', async () => {
    analyze = true
    analysisFailure = true
    const { result } = await readUploadedImage(false, true)
    expect(result?.content).toMatchObject({ error: 'ANALYSIS_FAILED' })
    analyze = false
    analysisFailure = false
  })

  it('suggests analysis only when an enabled service can read the file', async () => {
    const { result } = await readUploadedImage(false, true)
    expect(result?.content).toMatchObject({ error: 'UNSUPPORTED_FILE', message: expect.stringContaining('analyze_file') })
  })
})
