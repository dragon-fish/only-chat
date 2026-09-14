import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { models, pluginConfigs, providerInterfaces, providers, users, workspaceFileVersions, workspaceFiles } from '@/server/db/schema'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import type { UserHub } from '@/server/index'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import { listMessages } from '@/server/plugins/hub/conversations'
import { hasToolResult } from '@/server/plugins/mock-provider'
import { ensureTestUser as seedTestUser, workerFetch } from './auth-helper'
import { connect } from './ws-helper'

type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never

/** Emits one tool call, which the hub executes before finishing the turn. */
function toolCallStream(toolName: string, input: unknown): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: 'r', modelId: 'mock', timestamp: new Date(0) },
    { type: 'tool-call', toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 }, raw: {} },
    },
  ] as StreamPart[]
}

/** What the model answers with once its tool call has come back. */
const DONE_STREAM = [
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', id: 'r2', modelId: 'mock', timestamp: new Date(0) },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'done' },
  { type: 'text-end', id: 't1' },
  {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 }, raw: {} },
  },
] as StreamPart[]

async function seedProvider(): Promise<number> {
  const db = createDb(env.DB)
  await seedTestUser(db)
  await db.delete(workspaceFileVersions)
  await db.delete(workspaceFiles)
  const [provider] = await db.insert(providers).values({
    user_id: 1, name: 'files', api_key: await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'k'), enabled: true, created_at: 0,
  }).returning()
  const [iface] = await db.insert(providerInterfaces).values({
    provider_id: provider!.id, protocol: 'responses', base_url: 'https://mock.example/v1', native_files: false, created_at: 0,
  }).returning()
  await db.update(providers).set({ default_interface_id: iface!.id }).where(eq(providers.id, provider!.id))
  await db.insert(models).values({ provider_id: provider!.id, model_id: 'files-model', metadata_resolved: { tool_call: true }, enabled: true, sort: 0 })
  await db.update(users).set({ settings: { plugins: { workspace_files: true } } }).where(eq(users.id, 1))
  return provider!.id
}

let modelStream: StreamPart[] = []
let installed = false

/** The Durable Object outlives a test, so the model is installed once and its script swapped. */
async function installModel() {
  await connect(await seedTestUser())
  if (installed) return
  installed = true
  await runInDurableObject(env.USER_HUB.getByName(String(1)), async (instance: UserHub) => {
    await instance.app.plugin({
      name: 'files-model',
      inject: ['llm'],
      apply(ctx) {
        ctx.llm.register('responses', {
          createModel: () => new MockLanguageModelV4({
            // The hub loops while the model keeps calling tools. Emitting the same call on every
            // step would now overwrite the file once per step, so stop as soon as a result exists.
            // Only this turn counts: results from an earlier turn must not silence the next call.
            doStream: async ({ prompt }) => {
              return { stream: simulateReadableStream({
                chunks: hasToolResult(prompt) ? DONE_STREAM : modelStream,
                chunkDelayInMs: null,
                initialDelayInMs: null,
              }) }
            },
          }) as never,
        })
      },
    })
  })
}

/** Runs one turn whose model emits the given tool call, and returns the persisted result part. */
async function callTool(providerId: number, toolName: string, input: unknown, conversationId?: number) {
  modelStream = toolCallStream(toolName, input)
  const c = await connect(await seedTestUser())
  c.ws.send(JSON.stringify({
    type: 'send', conversation_id: conversationId ?? null, parent_id: null, parts: [{ type: 'text', text: 'go' }],
    provider_id: providerId, model_id: 'files-model',
    // Conversation-init fields are only accepted while creating one; the hub rejects the whole
    // command if they reappear later. The tool snapshot is already stored on the conversation.
    ...(conversationId === undefined ? { tools: ['list_files', 'read_file', 'write_file', 'preview_file'] } : {}),
  }))
  await c.next('message.done')
  const created = c.events.filter(e => e.type === 'message.created') as Array<{ message: { id: number, conversation_id: number, role: string } }>
  const assistant = created.find(event => event.message.role === 'assistant')!.message
  const rows = await listMessages(createDb(env.DB), assistant.conversation_id, 1)
  const message = rows.find(row => row.id === assistant.id)!
  const result = message.parts.find((part): part is ToolResultPart => part.type === 'tool_result')
  const call = message.parts.find((part): part is ToolCallPart => part.type === 'tool_call')
  return { conversationId: assistant.conversation_id, assistantId: assistant.id, result, call }
}

describe('workspace file tools', () => {
  it('writes a file the model asked for, and records where it came from', async () => {
    const providerId = await seedProvider()
    await installModel()
    const { conversationId, assistantId, result } = await callTool(providerId, 'write_file', {
      path: '/conversation/notes.md', content: 'first\nsecond',
    })

    expect(result?.content).toMatchObject({ operation: 'created', version: 1, totalLines: 2, fileSize: 12 })

    const db = createDb(env.DB)
    const [file] = await db.select().from(workspaceFiles).where(eq(workspaceFiles.conversation_id, conversationId))
    expect(file).toMatchObject({ relative_path: 'notes.md', current_version: 1 })
    const [version] = await db.select().from(workspaceFileVersions).where(eq(workspaceFileVersions.file_id, file!.id))
    // Provenance comes from the runtime, which is the whole point of building tools after the shell.
    expect(version).toMatchObject({
      version: 1, total_lines: 2, source_conversation_id: conversationId, source_message_id: assistantId,
      tool_call_id: 'call-write_file',
    })
  })

  it('reads back what it wrote, as numbered lines', async () => {
    const providerId = await seedProvider()
    await installModel()
    const { conversationId } = await callTool(providerId, 'write_file', { path: '/conversation/a.md', content: 'x\ny\nz' })
    const { result } = await callTool(providerId, 'read_file', { path: '/conversation/a.md', offset: 2, limit: 1 }, conversationId)

    expect(result?.content).toMatchObject({
      content: '2 | y', startLine: 2, returnedLines: 1, totalLines: 3, truncated: true, nextOffset: 3, version: 1,
    })
  })

  it('overwrites rather than refusing, and says what it displaced', async () => {
    const providerId = await seedProvider()
    await installModel()
    const { conversationId } = await callTool(providerId, 'write_file', { path: '/conversation/b.md', content: 'one' })
    const { result } = await callTool(providerId, 'write_file', { path: '/conversation/b.md', content: 'two' }, conversationId)

    // Refusing would discard whatever producing `two` cost, to protect a version that is still there.
    expect(result?.content).toMatchObject({ operation: 'replaced', version: 2, replacedVersion: 1 })
    expect(String((result?.content as { message: string }).message)).toContain('restore_file')
  })

  it('returns a correctable error when the named version is wrong', async () => {
    const providerId = await seedProvider()
    await installModel()
    const { conversationId } = await callTool(providerId, 'write_file', { path: '/conversation/c.md', content: 'one' })
    const { result } = await callTool(providerId, 'write_file', { path: '/conversation/c.md', content: 'two', expectedVersion: 99 }, conversationId)

    expect(result?.content).toMatchObject({ error: 'VERSION_CONFLICT' })
  })

  it('tells the model a project mount is unavailable instead of erroring', async () => {
    const providerId = await seedProvider()
    await installModel()
    const { result } = await callTool(providerId, 'list_files', { path: '/' })

    expect(result?.content).toMatchObject({
      path: '/',
      entries: [
        expect.objectContaining({ path: '/project', status: 'unavailable' }),
        expect.objectContaining({ path: '/conversation', status: 'empty' }),
      ],
    })
  })

  it('refuses a path that tries to escape its mount', async () => {
    const providerId = await seedProvider()
    await installModel()
    const { result } = await callTool(providerId, 'write_file', { path: '/conversation/../project/x.md', content: 'x' })
    expect(result?.content).toMatchObject({ error: 'INVALID_PATH' })
  })
})

describe('preview_file', () => {
  /** The setting is off by default; turning it on is what makes a page serve as a page. */
  async function enableHtmlPreview() {
    const db = createDb(env.DB)
    await db.delete(pluginConfigs)
    await db.insert(pluginConfigs).values({
      user_id: 1, plugin_id: 'workspace_files', key: 'html_preview', value: 'true', updated_at: Date.now(),
    })
  }

  it('hands back a URL the preview route actually serves the file from', async () => {
    const providerId = await seedProvider()
    await installModel()
    const { conversationId } = await callTool(providerId, 'write_file', {
      path: '/conversation/page.html', content: '<p>hi</p>',
    })
    const { result } = await callTool(providerId, 'preview_file', { path: '/conversation/page.html' }, conversationId)
    const out = result?.content as { url: string }

    // Absolute, because the model may hand it to a browser that is not on this origin.
    expect(out.url).toMatch(/^https?:\/\//)
    const served = await workerFetch(new URL(out.url).pathname)
    expect(served.status).toBe(200)
    expect(await served.text()).toBe('<p>hi</p>')
  })

  it('says whether the link will render or only show source', async () => {
    const providerId = await seedProvider()
    await installModel()
    const { conversationId } = await callTool(providerId, 'write_file', {
      path: '/conversation/page.html', content: '<p>hi</p>',
    })

    const off = await callTool(providerId, 'preview_file', { path: '/conversation/page.html' }, conversationId)
    expect(off.result?.content).toMatchObject({ renders: 'text' })

    await enableHtmlPreview()
    const on = await callTool(providerId, 'preview_file', { path: '/conversation/page.html' }, conversationId)
    expect(on.result?.content).toMatchObject({ renders: 'page' })
  })

  it('reports an unknown file as a fact rather than a malfunction', async () => {
    const providerId = await seedProvider()
    await installModel()
    const { result } = await callTool(providerId, 'preview_file', { path: '/conversation/missing.html' })
    expect(result?.content).toMatchObject({ error: 'FILE_NOT_FOUND' })
  })
})

describe('write_file previewability', () => {
  it('marks a file the model could preview, and leaves the rest alone', async () => {
    const providerId = await seedProvider()
    await installModel()
    const page = await callTool(providerId, 'write_file', { path: '/conversation/a.html', content: '<p>x</p>' })
    expect(page.result?.content).toMatchObject({ previewable: true })

    const notes = await callTool(providerId, 'write_file', { path: '/conversation/a.md', content: 'x' }, page.conversationId)
    expect(notes.result?.content).toMatchObject({ previewable: false })
  })
})
