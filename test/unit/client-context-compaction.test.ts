// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SlashCommandContext } from '@/client/plugins/host'
import { checkpointLabel, compactionDataOf, createCompressCommand } from '@/plugins/context-compaction/client/compress'
import type { CheckpointPart } from '@/shared/parts'
import { ClientPluginHost } from '@/client/plugins/host'
import manifest from '@/plugins/context-compaction/manifest'

function context(over: Partial<SlashCommandContext> = {}) {
  const sent: unknown[] = []
  const handlers = new Set<(payload: unknown) => void>()
  const ctx: SlashCommandContext = {
    conversationId: 7, streaming: false, compacting: false,
    send: (payload) => { sent.push(payload); return true },
    on: (handler) => { handlers.add(handler); return () => { handlers.delete(handler) } },
    toast: () => {},
    ...over,
  }
  const emit = (payload: unknown) => { for (const handler of [...handlers]) handler(payload) }
  return { ctx, sent, handlers, emit }
}

afterEach(() => { vi.useRealTimers() })

describe('/compress', () => {
  it('says why it cannot run', () => {
    const command = createCompressCommand()
    expect(command.enabled!(context({ conversationId: null }).ctx)).toBe('会话还没开始')
    expect(command.enabled!(context({ streaming: true }).ctx)).toBe('生成中不可用')
    expect(command.enabled!(context({ compacting: true }).ctx)).toBe('正在压缩上下文')
    expect(command.enabled!(context().ctx)).toBe(true)
  })

  it('sends the focus and resolves on its own result only', async () => {
    const { ctx, sent, handlers, emit } = context()
    let settled = false
    const run = createCompressCommand({ newRequestId: () => 'r1' }).run(ctx, '  keep the API decisions  ').then(() => { settled = true })
    expect(sent).toEqual([{ type: 'compress', requestId: 'r1', conversationId: 7, focus: 'keep the API decisions' }])
    emit({ type: 'compress.result', requestId: 'other', ok: false, error: 'not mine' })
    emit({ type: 'notice', conversationId: 7, kind: 'failed', message: 'unrelated' })
    await Promise.resolve()
    expect(settled).toBe(false)
    emit({ type: 'compress.result', requestId: 'r1', ok: true })
    await run
    expect(handlers.size).toBe(0)
  })

  it('sends no focus when nothing follows the command', async () => {
    const { ctx, sent, emit } = context()
    const run = createCompressCommand({ newRequestId: () => 'r2' }).run(ctx, '')
    emit({ type: 'compress.result', requestId: 'r2', ok: true })
    await run
    expect(sent).toEqual([{ type: 'compress', requestId: 'r2', conversationId: 7, focus: null }])
  })

  it('rejects with the server error', async () => {
    const { ctx, emit } = context()
    const run = createCompressCommand({ newRequestId: () => 'r3' }).run(ctx, '')
    emit({ type: 'compress.result', requestId: 'r3', ok: false, error: '可在设置中配置压缩备用模型' })
    await expect(run).rejects.toThrow('可在设置中配置压缩备用模型')
  })

  it('rejects when no answer comes, and stops listening', async () => {
    vi.useFakeTimers()
    const { ctx, handlers } = context()
    const run = createCompressCommand({ timeoutMs: 1000 }).run(ctx, '')
    const outcome = expect(run).rejects.toThrow(/超时/)
    vi.advanceTimersByTime(1000)
    await outcome
    expect(handlers.size).toBe(0)
  })

  it('rejects at once when no socket carries the command', async () => {
    const { ctx, handlers } = context({ send: () => false })
    await expect(createCompressCommand().run(ctx, '')).rejects.toThrow('未连接')
    expect(handlers.size).toBe(0)
  })
})

describe('checkpoint label', () => {
  const part = (data: unknown): CheckpointPart => ({ type: 'checkpoint', plugin: 'context_compaction', content: '', attachments: [], contributors: [], data })

  it('shows the size of what was replaced, and only that it was compacted when the data is unreadable', () => {
    const data = { trigger: 'manual', summary: 's', files: { read: [], modified: [] }, focus: null, tokensBefore: 128_400, mode: 'cached' }
    expect(checkpointLabel(compactionDataOf(part(data)))).toBe('上下文已压缩 · 约 128.4k token')
    expect(compactionDataOf(part({ something: 'else' }))).toBeNull()
    expect(checkpointLabel(null)).toBe('上下文已压缩')
  })
})

it('registers its checkpoint renderer and /compress with the host', async () => {
  const sent: unknown[] = []
  const host = new ClientPluginHost({ manifests: [manifest], loaders: { [manifest.id]: () => import('@/plugins/context-compaction/client') } })
  host.setSender((command) => { sent.push(command); return true })
  expect(await host.ensureCheckpointRenderer(manifest.id)).toBeDefined()
  const run = host.runSlashCommand(
    { pluginId: manifest.id, name: 'compress', args: 'focus' },
    { conversationId: 3, streaming: false, compacting: false, toast: () => {} },
  )
  await vi.waitFor(() => expect(sent).toHaveLength(1))
  const { payload } = sent[0] as { payload: { requestId: string } }
  expect(sent[0]).toMatchObject({ type: 'plugin.command', plugin: manifest.id, payload: { type: 'compress', conversationId: 3, focus: 'focus' } })
  host.dispatchEvent(manifest.id, { type: 'compress.result', requestId: payload.requestId, ok: true })
  await run
  await expect(host.runSlashCommand(
    { pluginId: manifest.id, name: 'compress', args: '' },
    { conversationId: 3, streaming: false, compacting: true, toast: () => {} },
  )).rejects.toThrow('正在压缩上下文')
})
