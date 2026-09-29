import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '@/server/db/client'
import { mcpServers, models, providerInterfaces, providers, users } from '@/server/db/schema'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import { listMessages } from '@/server/plugins/hub/conversations'
import { hasToolResult } from '@/server/plugins/mock-provider'
import type { UserHub } from '@/server/index'
import type { ToolResultPart } from '@/shared/parts'
import { ensureTestUser } from './auth-helper'
import { connect } from './ws-helper'
import { FAKE_MCP_URL, fakeMcpServer } from './mcp-fake-server'

type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 }, raw: {} }
const callStream = (toolName: string, input: unknown) => [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-call', toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
] as StreamPart[]
const DONE = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'done' }, { type: 'text-end', id: 't' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
] as StreamPart[]

let firstStep: StreamPart[] = []
let installed = false

async function setup(): Promise<number> {
  const db = createDb(env.DB)
  await ensureTestUser(db)
  const [provider] = await db.insert(providers).values({
    user_id: 1, name: 'mcp', api_key: await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'k'), enabled: true, created_at: 0,
  }).returning()
  const [iface] = await db.insert(providerInterfaces).values({
    provider_id: provider!.id, protocol: 'responses', base_url: 'https://mock.example/v1', native_files: false, created_at: 0,
  }).returning()
  await db.update(providers).set({ default_interface_id: iface!.id }).where(eq(providers.id, provider!.id))
  await db.insert(models).values({ provider_id: provider!.id, model_id: 'mcp-model', metadata_resolved: { tool_call: true }, enabled: true, sort: 0 })
  await db.update(users).set({ settings: { plugins: { mcp: true } } }).where(eq(users.id, 1))
  await db.delete(mcpServers)
  await db.insert(mcpServers).values({ user_id: 1, key: 'fake0001', name: 'Fake', url: FAKE_MCP_URL, created_at: 0, updated_at: 0 })

  await connect(await ensureTestUser())
  if (!installed) {
    installed = true
    await runInDurableObject(env.USER_HUB.getByName('1'), async (instance: UserHub) => {
      await instance.app.plugin({
        name: 'mcp-model',
        inject: ['llm'],
        apply(ctx) {
          ctx.llm.register('responses', {
            createModel: () => new MockLanguageModelV4({
              doStream: async ({ prompt }) => ({
                stream: simulateReadableStream({ chunks: hasToolResult(prompt) ? DONE : firstStep, chunkDelayInMs: null, initialDelayInMs: null }),
              }),
            }) as never,
          })
        },
      })
    })
  }
  return provider!.id
}

afterEach(() => { vi.unstubAllGlobals() })

describe('MCP tools inside a generation', () => {
  it('lists services and calls a tool from the Durable Object, then settles', async () => {
    const providerId = await setup()
    const server = fakeMcpServer()
    vi.stubGlobal('fetch', server.fetch)

    for (const [toolName, input] of [['mcp_list_services', {}], ['mcp_call_tool', { service_id: 'fake0001', tool_name: 'search', params: { query: 'vue' } }]] as const) {
      firstStep = callStream(toolName, input)
      const c = await connect(await ensureTestUser())
      c.ws.send(JSON.stringify({
        type: 'send', conversation_id: null, parent_id: null, parts: [{ type: 'text', text: 'go' }],
        provider_id: providerId, model_id: 'mcp-model', tools: ['mcp_list_services', 'mcp_list_tools', 'mcp_call_tool'],
      }))
      const done = await c.next('message.done') as { status: string, error: string | null, message_id: number }
      expect(done.error).toBeNull()
      expect(done.status).toBe('done')
      const created = c.events.filter(e => e.type === 'message.created') as Array<{ message: { conversation_id: number } }>
      const messages = await listMessages(createDb(env.DB), created[0]!.message.conversation_id, 1)
      const result = messages.flatMap(message => message.parts).find((part): part is ToolResultPart => part.type === 'tool_result')
      expect(result?.content).not.toHaveProperty('error')
    }
    expect(server.calls).toEqual([{ name: 'search', arguments: { query: 'vue' } }])
  })
})
