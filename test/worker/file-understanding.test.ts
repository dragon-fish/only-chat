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

/** What the main model calls on its first step; the file reference is filled in per test. */
let call: { tool: 'read_file' | 'analyze_file', input: Record<string, unknown> } = { tool: 'read_file', input: {} }
const CALL = (): StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-call', toolCallId: 'call-file', toolName: call.tool, input: JSON.stringify(call.input) },
  finish('tool-calls'),
]
const TEXT: StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'ok' }, { type: 'text-end', id: 't' },
  finish('stop'),
]
const prompts: Array<Array<{ role: string, content: Array<{ type: string, text?: string, output?: unknown }> }>> = []
/** What the service model was asked, and how it answers. */
let analysis: { prompt?: unknown, fail?: boolean, hang?: boolean, aborted?: boolean } = {}
let installed = false

const SYSTEM = 'Describe every detail. 原文保持原样。'

async function seed(options: { vision: boolean, service: boolean, mime: string, analystInput?: string[] }) {
  const db = createDb(env.DB)
  await ensureTestUser(db)
  const audio = options.mime.startsWith('audio/') || options.mime.startsWith('video/')
  const [provider] = await db.insert(providers).values({
    user_id: 1, name: 'file-understanding', api_key: await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'k'), enabled: true, created_at: 0,
  }).returning()
  const [iface] = await db.insert(providerInterfaces).values({
    provider_id: provider!.id, protocol: audio ? 'chat-completions' : 'responses', base_url: 'https://mock.example/v1', native_files: false, created_at: 0,
  }).returning()
  await db.update(providers).set({ default_interface_id: iface!.id }).where(eq(providers.id, provider!.id))
  await db.insert(models).values([
    { provider_id: provider!.id, model_id: 'reader', enabled: true, sort: 0, metadata_resolved: { tool_call: true, modalities: { input: options.vision ? ['text', 'image', 'pdf'] : ['text'], output: ['text'] } } },
    { provider_id: provider!.id, model_id: 'analyst', enabled: true, sort: 1, metadata_resolved: { modalities: { input: (options.analystInput ?? ['text', 'image', 'pdf', 'audio', 'video']) as never, output: ['text'] } } },
  ])
  await db.update(users).set({ settings: {
    plugins: { file_understanding: true },
    service_models: { file_understanding: options.service ? { provider_id: provider!.id, model_id: 'analyst' } : null },
    service_prompts: { file_understanding: SYSTEM },
  } }).where(eq(users.id, 1))
  const bytes = options.mime === 'image/png' ? new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])
    : new TextEncoder().encode(options.mime === 'application/pdf' ? '%PDF-1.7' : options.mime === 'audio/mpeg' ? 'ID3recording' : '\0\0\0\x18ftypisom')
  const key = `file-understanding/${crypto.randomUUID()}`
  await env.BUCKET.put(key, bytes)
  const sha256 = (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', '').slice(0, 64)
  const [attachment] = await db.insert(attachments).values({
    user_id: 1, sha256, mime: options.mime, size: bytes.byteLength, width: null, height: null, r2_key: key, origin: 'upload', created_at: 0,
  }).returning()
  return { providerId: provider!.id, attachmentId: attachment!.id, ref: `asset:${sha256.slice(0, 8)}` }
}

async function install() {
  if (installed) return
  installed = true
  await runInDurableObject(env.USER_HUB.getByName('1'), async (instance: UserHub) => {
    await instance.app.plugin({
      name: 'file-understanding-model', inject: ['llm'],
      apply(ctx) {
        for (const protocol of ['responses', 'chat-completions'] as const) ctx.llm.register(protocol, {
          createModel: () => new MockLanguageModelV4({
            doGenerate: async ({ prompt, abortSignal }) => {
              analysis.prompt = prompt
              if (analysis.hang) {
                await new Promise((_, reject) => abortSignal?.addEventListener('abort', () => {
                  analysis.aborted = true
                  reject(abortSignal.reason)
                }))
              }
              if (analysis.fail) throw new Error('analysis provider failed')
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

/** One turn: the person sends the file, the model calls the tool on `input(ref)`. */
async function turn(options: { vision: boolean, service: boolean, mime?: string, analystInput?: string[], tools: string[], tool: 'read_file' | 'analyze_file', input: (ref: string) => Record<string, unknown>, stop?: boolean }) {
  const mime = options.mime ?? 'image/png'
  const seeded = await seed({ vision: options.vision, service: options.service, mime, analystInput: options.analystInput })
  const c = await connect(await ensureTestUser())
  await install()
  call = { tool: options.tool, input: options.input(seeded.ref) }
  prompts.length = 0
  c.ws.send(JSON.stringify({
    type: 'send', conversation_id: null, parent_id: null,
    parts: [mime.startsWith('image/') ? { type: 'image', attachment_id: seeded.attachmentId } : { type: 'file', attachment_id: seeded.attachmentId, mime }, { type: 'text', text: 'what is this?' }],
    provider_id: seeded.providerId, model_id: 'reader', tools: options.tools,
  }))
  const created = await c.next('message.created') as { message: { conversation_id: number } }
  if (options.stop) {
    await expect.poll(() => analysis.prompt !== undefined).toBe(true)
    c.ws.send(JSON.stringify({ type: 'stop', conversation_id: created.message.conversation_id }))
  }
  const done = await c.next('message.done') as { status: string }
  const rows = await listMessages(createDb(env.DB), created.message.conversation_id, 1)
  const result = rows[1]!.parts.find((part): part is ToolResultPart => part.type === 'tool_result')
  return { ...seeded, result, status: done.status }
}

describe('read_file with file understanding', () => {
  it('delivers the file after the tool results, with no attachment id anywhere the model reads', async () => {
    const { attachmentId, ref, result } = await turn({ vision: true, service: false, tools: ['read_file'], tool: 'read_file', input: file => ({ file }) })
    expect(result).toMatchObject({ content: { file: ref, mime: 'image/png' }, attachments: [attachmentId] })
    const second = prompts[1]!
    const toolAt = second.findIndex(message => message.role === 'tool')
    expect(second[toolAt + 1]!.content.map(part => part.type)).toEqual(['text', 'file', 'text'])
    // A system message carries plain text; every other message a list of parts.
    const readable = second.flatMap(message => typeof message.content === 'string'
      ? [message.content]
      : message.content.flatMap(part => [part.text ?? '', JSON.stringify(part.output ?? '')]))
    expect(readable.some(text => new RegExp(`\\b${attachmentId}\\b`).test(text))).toBe(false)
  })

  it('refuses a path when nothing enabled serves paths', async () => {
    const { result } = await turn({ vision: true, service: false, tools: ['read_file'], tool: 'read_file', input: () => ({ file: '/project/cat.png' }) })
    expect(result?.content).toMatchObject({ error: 'INVALID_FILE_REF', message: expect.stringContaining('asset:') })
  })

  it('points a model that cannot read the file at analyze_file only when that would work', async () => {
    const withService = await turn({ vision: false, service: true, tools: ['read_file', 'analyze_file'], tool: 'read_file', input: file => ({ file }) })
    expect(withService.result?.content).toMatchObject({ error: 'UNSUPPORTED_FILE', message: expect.stringContaining(`analyze_file with file ${withService.ref}`) })
    const without = await turn({ vision: false, service: false, tools: ['read_file', 'analyze_file'], tool: 'read_file', input: file => ({ file }) })
    expect(without.result?.content).toMatchObject({ error: 'UNSUPPORTED_FILE' })
    expect((without.result?.content as { message: string }).message).not.toContain('analyze_file')
  })
})

describe('analyze_file', () => {
  it.each(['image/png', 'application/pdf', 'audio/mpeg', 'video/mp4'])('hands %s to the service model with the prompt and question kept apart', async mime => {
    analysis = {}
    const { ref, result } = await turn({ vision: false, service: true, mime, tools: ['analyze_file'], tool: 'analyze_file', input: file => ({ file, question: '转写所有文字' }) })
    expect(result?.content).toMatchObject({
      file: ref, mime, model: { model_id: 'analyst', provider_name: 'file-understanding' },
      usage: { prompt: 1, completion: 1 }, text: '详细描述：图片文字为“你好”。', truncated: false,
    })
    // The file type is stated, so a model primed for pictures is not left guessing what it was sent.
    expect(analysis.prompt).toMatchObject([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: [{ type: 'file', mediaType: mime }, { type: 'text', text: `File type: ${mime}` }, { type: 'text', text: '转写所有文字' }] },
    ])
    // The text-only main model never received the bytes.
    expect(prompts.flatMap(messages => messages.flatMap(message => message.content)).some(part => part.type === 'file')).toBe(false)
  })

  it('adds nothing but the file type when there is no question', async () => {
    analysis = {}
    await turn({ vision: false, service: true, tools: ['analyze_file'], tool: 'analyze_file', input: file => ({ file }) })
    expect((analysis.prompt as Array<{ content: unknown[] }>)[1]!.content).toEqual([
      expect.objectContaining({ type: 'file' }), { type: 'text', text: 'File type: image/png' },
    ])
  })

  it('reports an unconfigured service, and a provider failure, as tool errors', async () => {
    analysis = {}
    expect((await turn({ vision: false, service: false, tools: ['analyze_file'], tool: 'analyze_file', input: file => ({ file }) })).result?.content)
      .toMatchObject({ error: 'SERVICE_UNAVAILABLE' })
    analysis = { fail: true }
    expect((await turn({ vision: false, service: true, tools: ['analyze_file'], tool: 'analyze_file', input: file => ({ file }) })).result?.content)
      .toMatchObject({ error: 'ANALYSIS_FAILED' })
    analysis = {}
  })

  it('refuses a file type the service model cannot read', async () => {
    analysis = {}
    const { result } = await turn({ vision: false, service: true, mime: 'application/pdf', analystInput: ['text', 'image'], tools: ['analyze_file'], tool: 'analyze_file', input: file => ({ file }) })
    expect(result?.content).toMatchObject({ error: 'UNSUPPORTED_FILE' })
    expect(analysis.prompt).toBeUndefined()
  })

  it('stops with the generation', async () => {
    analysis = { hang: true }
    const { status } = await turn({ vision: false, service: true, tools: ['analyze_file'], tool: 'analyze_file', input: file => ({ file }), stop: true })
    expect(status).toBe('aborted')
    expect(analysis.aborted).toBe(true)
    analysis = {}
  })
})
