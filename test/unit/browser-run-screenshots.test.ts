import { Context, Service } from 'cordis'
import { describe, expect, it } from 'vitest'
import type { Tool } from 'ai'
import { BrowserRunServerPlugin } from '@/plugins/cloudflare-browser-run/server'
import { BROWSER_USE_TOOL_ID } from '@/shared/plugins'
import type { ToolContext, ToolFactory } from '@/server/plugins/tools'
import { carriesToolResultImages } from '@/server/plugins/llm/messages'

const SHOT_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x11, 0x22])

/**
 * A real cordis `Service`, not a plain object: service access hands out a fresh traceable Proxy
 * every read, and that is exactly the condition the plugin's state has to survive. A plain object
 * would be identity-stable and would let the bug this covers pass.
 */
class FakeHub extends Service {
  static readonly provide = 'hub'
  readonly userId = 1
  readonly storage = new Map<string, unknown>()
  readonly db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    insert: () => ({ values: () => ({ returning: async () => [{ id: 4242 }] }) }),
  }
  readonly app = { assets: { put: async () => {} } }
  readonly state = {
    storage: {
      get: async (key: string) => this.storage.get(key),
      put: async (key: string, value: unknown) => { this.storage.set(key, value) },
      delete: async (key: string) => { this.storage.delete(key) },
    },
  }
  constructor(ctx: Context) { super(ctx, 'hub') }
  async broadcastGeneration(): Promise<void> {}
  async broadcastPlugin(): Promise<void> {}
}

type HostCallHandler = (payload: unknown) => Promise<unknown>

/**
 * Wires the plugin the way the hub does, and stands in for the Dynamic Worker: the fake runner
 * calls `attach` back through the plugin channel, as the real harness does for `ctx.screenshot()`.
 */
async function loadPlugin() {
  const ctx = new Context()
  let factory: ToolFactory | undefined
  let hostCall: HostCallHandler | undefined

  ctx.provide('tools', {
    register: (_pluginId: string, toolId: string, made: ToolFactory) => {
      if (toolId === BROWSER_USE_TOOL_ID) factory = made
      return () => {}
    },
  })
  ctx.provide('pluginChannel', {
    onCommand: () => {},
    onHostCall: (_pluginId: string, handler: HostCallHandler) => { hostCall = handler },
  })
  ctx.provide('env', {
    BROWSER: {
      fetch: async (input: unknown) => String(input).includes('/v1/acquire')
        ? new Response(JSON.stringify({ sessionId: 'sess-1' }))
        : new Response(JSON.stringify({ sessions: [{ sessionId: 'sess-1' }] })),
    },
    KV: { get: async () => null, put: async () => {} },
    BROWSER_RUNNER: {
      run: async (args: { callId: string }) => {
        const attachmentId = await hostCall!({
          kind: 'attach', conversationId: 7, messageId: 42, callId: args.callId,
          name: 'shot-1', mime: 'image/jpeg', bytes: SHOT_BYTES.buffer,
        }) as number
        return {
          ok: true, result: 'ok', timedOut: false, url: 'https://example.test', title: 'T',
          storageState: null, liveView: null, screenshots: [{ attachmentId, name: 'shot-1' }],
        }
      },
    },
  })
  await ctx.plugin(FakeHub)
  await ctx.plugin(BrowserRunServerPlugin)
  if (!factory || !hostCall) throw new Error('plugin did not register')
  return factory
}

function toolContext(overrides: Partial<ToolContext>): ToolContext {
  return {
    userId: 1, conversationId: 7, projectId: null, assistantMessageId: 42,
    config: {}, conversationConfig: {}, turn: new Map<string, unknown>(),
    db: {} as ToolContext['db'], assets: {} as ToolContext['assets'],
    signal: new AbortController().signal,
    acceptsImages: true, acceptsToolResultImages: true,
    publicOrigin: 'https://chat.test', path: [],
    ...overrides,
  }
}

async function runOnce(tool: Tool, callId: string) {
  const input = { code: 'export const run = async () => {}' }
  const execute = tool.execute as (i: unknown, o: unknown) => Promise<unknown>
  const output = await execute(input, { toolCallId: callId, messages: [] })
  const toModelOutput = tool.toModelOutput as (a: unknown) => { type: string; value: unknown }
  return { output, model: toModelOutput({ toolCallId: callId, input, output }) }
}

describe('browser_use screenshots', () => {
  it('hands the bytes to a model and protocol that can take them', async () => {
    const factory = await loadPlugin()
    const { output, model } = await runOnce(factory(toolContext({})), 'call-1')

    // The attachment id is the durable half and must still be in the JSON either way.
    expect(output).toMatchObject({ screenshots: [{ attachment_id: 4242, name: 'shot-1' }] })
    expect(model.type).toBe('content')
    const parts = model.value as Array<{ type: string; data?: { data: Uint8Array } }>
    expect(parts.filter(p => p.type === 'file')).toHaveLength(1)
    expect(parts.find(p => p.type === 'file')?.data?.data).toEqual(SHOT_BYTES)
  })

  it('tells the model what it is missing when the protocol cannot carry a picture', async () => {
    const factory = await loadPlugin()
    const tool = factory(toolContext({ acceptsToolResultImages: false }))
    const { model } = await runOnce(tool, 'call-2')

    expect(model.type).toBe('text')
    const text = model.value as string
    // Silence would read as "you were shown the screenshot"; the id alone invites the model to
    // describe pixels it never received.
    expect(text).toContain('1 screenshot was captured and stored')
    expect(text).toContain('cannot carry an image inside a tool result')
    expect(text).toContain('"attachment_id":4242')
  })

  it('says the model is the limit when it takes no images at all', async () => {
    const factory = await loadPlugin()
    const tool = factory(toolContext({ acceptsImages: false }))
    const { model } = await runOnce(tool, 'call-3')

    expect(model.type).toBe('text')
    expect(model.value as string).toContain('does not accept image input')
  })
})

describe('tool result image transport', () => {
  it('refuses chat-completions, where the bytes would be JSON-stringified instead of sent', () => {
    expect(carriesToolResultImages('chat-completions')).toBe(false)
    expect(carriesToolResultImages('anthropic')).toBe(true)
    expect(carriesToolResultImages('responses')).toBe(true)
    expect(carriesToolResultImages('vertex-compatible')).toBe(true)
  })
})
