import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { artifactRunInputs, artifactRuns, attachments, models, providerInterfaces, providers, users } from '@/server/db/schema'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import { listMessages } from '@/server/plugins/hub/conversations'
import { hasToolResult } from '@/server/plugins/mock-provider'
import { NO_IMAGE_MODEL } from '@/plugins/image-generation/server'
import type { UserHub } from '@/server/index'
import type { Part, ToolResultPart } from '@/shared/parts'
import { ensureTestUser } from './auth-helper'
import { connect } from './ws-helper'

type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never

const finish = (unified: 'stop' | 'tool-calls') => ({
  type: 'finish', finishReason: { unified, raw: unified },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 }, raw: {} },
})

let toolInput: unknown = {}
const CALL_STREAM = (): StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', id: 'r', modelId: 'mock', timestamp: new Date(0) },
  { type: 'tool-call', toolCallId: 'call-image', toolName: 'generate_image', input: JSON.stringify(toolInput) },
  finish('tool-calls'),
] as StreamPart[]
const DONE_STREAM = [
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', id: 'r2', modelId: 'mock', timestamp: new Date(0) },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'on its way' },
  { type: 'text-end', id: 't1' },
  finish('stop'),
] as StreamPart[]

/** A chat model that calls generate_image once, and an image model for the user's global image slot. */
async function seed(withImageModel: boolean, imageInput = true) {
  const db = createDb(env.DB)
  await ensureTestUser(db)
  const [provider] = await db.insert(providers).values({
    user_id: 1, name: 'image-tool', api_key: await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'k'), enabled: true, created_at: 0,
  }).returning()
  const [iface] = await db.insert(providerInterfaces).values({
    provider_id: provider!.id, protocol: 'responses', base_url: 'https://mock.example/v1', native_files: false, created_at: 0,
  }).returning()
  await db.update(providers).set({ default_interface_id: iface!.id }).where(eq(providers.id, provider!.id))
  await db.insert(models).values([
    { provider_id: provider!.id, model_id: 'chat-model', metadata_resolved: { tool_call: true }, enabled: true, sort: 0 },
    {
      provider_id: provider!.id, model_id: 'image-model', supports_image_output: true, supports_image_input: imageInput, enabled: true, sort: 1,
      metadata_resolved: { modalities: { input: imageInput ? ['text', 'image'] : ['text'], output: ['image'] } },
    },
  ])
  await db.update(users).set({ settings: {
    plugins: { image_generation: true },
    ...(withImageModel ? { service_models: { image: { provider_id: provider!.id, model_id: 'image-model' } } } : {}),
  } }).where(eq(users.id, 1))
  return provider!.id
}

let installed = false
async function installModel() {
  await connect(await ensureTestUser())
  if (installed) return
  installed = true
  await runInDurableObject(env.USER_HUB.getByName('1'), async (instance: UserHub) => {
    // A real Workflow would start generating in the background and outlive the test.
    Object.assign(instance.app.env, { ARTIFACT_WORKFLOW: { create: async ({ id }: { id: string }) => ({ id, dispose() {} }) } })
    await instance.app.plugin({
      name: 'image-tool-model',
      inject: ['llm'],
      apply(ctx) {
        ctx.llm.register('responses', {
          createModel: () => new MockLanguageModelV4({
            doStream: async ({ prompt }) => ({ stream: simulateReadableStream({
              chunks: hasToolResult(prompt) ? DONE_STREAM : CALL_STREAM(), chunkDelayInMs: null, initialDelayInMs: null,
            }) }),
          }) as never,
        })
      },
    })
  })
}

async function uploaded(mime = 'image/png'): Promise<{ id: number, ref: string, part: Part }> {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const key = `image-tool/${Date.now()}-${Math.random()}`
  // The chat turn may send the person's file to the chat model, so its bytes must exist.
  await env.BUCKET.put(key, bytes)
  const sha256 = (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', '').slice(0, 64)
  const [row] = await createDb(env.DB).insert(attachments).values({
    user_id: 1, sha256, mime, size: bytes.byteLength, width: 1, height: 1, r2_key: key, origin: 'upload', created_at: 0,
  }).returning()
  const part: Part = mime.startsWith('image/') ? { type: 'image', attachment_id: row!.id } : { type: 'file', attachment_id: row!.id, mime }
  return { id: row!.id, ref: `asset:${sha256.slice(0, 8)}`, part }
}

async function callGenerateImage(providerId: number, input: unknown, sent?: Part) {
  toolInput = input
  const c = await connect(await ensureTestUser())
  c.ws.send(JSON.stringify({
    type: 'send', conversation_id: null, parent_id: null,
    parts: [...(sent === undefined ? [] : [sent]), { type: 'text', text: 'draw' }],
    provider_id: providerId, model_id: 'chat-model', tools: ['generate_image'],
  }))
  await c.next('message.done')
  const created = c.events.filter(e => e.type === 'message.created') as Array<{ message: { id: number, conversation_id: number, role: string } }>
  const assistant = created.find(event => event.message.role === 'assistant')!.message
  const rows = await listMessages(createDb(env.DB), assistant.conversation_id, 1)
  const message = rows.find(row => row.id === assistant.id)!
  return message.parts.find((part): part is ToolResultPart => part.type === 'tool_result')
}

describe('generate_image', () => {
  it('starts a background run and returns at once', async () => {
    const providerId = await seed(true)
    await installModel()
    const result = await callGenerateImage(providerId, { prompt: 'an otter', count: 2 })
    expect(result?.content).toMatchObject({ status: 'started', count: 2, model: 'image-model', task_id: expect.stringMatching(/^image_run:\d+$/) })
    const runId = Number((result!.content as { task_id: string }).task_id.split(':')[1])
    expect(await createDb(env.DB).query.artifactRuns.findFirst({ where: eq(artifactRuns.id, runId) }))
      .toMatchObject({ source: 'tool', prompt: 'an otter', params: { count: 2, size: null }, tool_call_id: 'call-image' })
  })

  it('explains a missing image model instead of failing the turn', async () => {
    const providerId = await seed(false)
    await installModel()
    const result = await callGenerateImage(providerId, { prompt: 'an otter' })
    expect(result?.content).toEqual({ error: NO_IMAGE_MODEL })
  })

  it('edits an image the user sent, by the asset reference the conversation labels it with', async () => {
    const providerId = await seed(true)
    await installModel()
    const image = await uploaded()
    const result = await callGenerateImage(providerId, { prompt: 'make it blue', reference_images: [image.ref] }, image.part)
    const runId = Number((result!.content as { task_id: string }).task_id.split(':')[1])
    const db = createDb(env.DB)
    expect(await db.query.artifactRuns.findFirst({ where: eq(artifactRuns.id, runId) })).toMatchObject({ operation: 'edit' })
    expect(await db.select().from(artifactRunInputs).where(eq(artifactRunInputs.run_id, runId))).toEqual([expect.objectContaining({ attachment_id: image.id, position: 0 })])
  })

  it.each([
    ['an asset this conversation never showed', async () => ({ ref: (await uploaded()).ref, sent: undefined, code: 'FILE_NOT_FOUND' })],
    ['a file that is not an image', async () => { const pdf = await uploaded('application/pdf'); return { ref: pdf.ref, sent: pdf.part, code: 'UNSUPPORTED_FILE' } }],
    ['a bare path', async () => ({ ref: '/project/cat.png', sent: undefined, code: 'INVALID_FILE_REF' })],
  ])('refuses %s without starting a run', async (_, make) => {
    const providerId = await seed(true)
    await installModel()
    const { ref, sent, code } = await make()
    const before = (await createDb(env.DB).select().from(artifactRuns)).length
    const result = await callGenerateImage(providerId, { prompt: 'make it blue', reference_images: [ref] }, sent)
    expect(result?.content).toMatchObject({ code, error: expect.any(String) })
    expect((await createDb(env.DB).select().from(artifactRuns)).length).toBe(before)
  })

  it('refuses references the image model cannot take, without starting a run', async () => {
    const providerId = await seed(true, false)
    await installModel()
    const image = await uploaded()
    const before = (await createDb(env.DB).select().from(artifactRuns)).length
    const result = await callGenerateImage(providerId, { prompt: 'make it blue', reference_images: [image.ref] }, image.part)
    expect(result?.content).toEqual({ error: 'model does not support image input' })
    expect((await createDb(env.DB).select().from(artifactRuns)).length).toBe(before)
  })
})

