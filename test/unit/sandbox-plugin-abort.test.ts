import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import type { Tool } from 'ai'
import { SandboxServerPlugin } from '@/plugins/sandbox/server'
import { SANDBOX_EXEC_TOOL_ID } from '@/plugins/sandbox/shared'
import type { ToolContext, ToolFactory } from '@/server/plugins/tools'
import type { SandboxRpc } from '@/server/sandbox/protocol'

/** Wires the plugin the way the hub does, with `env.SANDBOX` handing out the given stub. */
async function loadExecTool(sandbox: Partial<SandboxRpc>): Promise<ToolFactory> {
  const ctx = new Context()
  let factory: ToolFactory | undefined
  ctx.provide('tools', {
    register: (_pluginId: string, toolId: string, made: ToolFactory) => {
      if (toolId === SANDBOX_EXEC_TOOL_ID) factory = made
      return () => {}
    },
  })
  ctx.provide('env', { SANDBOX: { getByName: () => sandbox } })
  ctx.provide('hub', { userId: 1, broadcastGeneration: async () => {} })
  ctx.provide('db', {})
  ctx.provide('assets', {})
  ctx.provide('fileReader', { registerScheme: () => () => {} })
  ctx.provide('pluginConfig', { read: async () => ({}) })
  ctx.provide('promptSections', { register: () => () => {} })
  await ctx.plugin(SandboxServerPlugin)
  if (!factory) throw new Error('plugin did not register')
  return factory
}

function toolContext(overrides: Partial<ToolContext>): ToolContext {
  return {
    userId: 1, conversationId: 7, projectId: null, assistantMessageId: 42,
    config: {}, conversationConfig: {}, turn: new Map<string, unknown>(),
    db: {} as ToolContext['db'], assets: {} as ToolContext['assets'],
    signal: new AbortController().signal,
    acceptsImages: true, acceptsToolResultImages: true,
    toolIds: [], canReadFile: () => false,
    publicOrigin: 'https://chat.test', path: [],
    ...overrides,
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('sandbox_exec when the turn is stopped', () => {
  it('returns without waiting for a machine that is still starting, and asks for the kill', async () => {
    const kills: string[] = []
    const factory = await loadExecTool({
      exec: () => new Promise(() => {}),
      kill: async (_userId, execId) => { kills.push(execId) },
    })
    const controller = new AbortController()
    const tool: Tool = factory(toolContext({ signal: controller.signal }))
    const execute = tool.execute as (input: unknown, options: unknown) => Promise<unknown>
    const result = execute({ command: 'echo hi' }, { toolCallId: 'call-1', messages: [] })
    await sleep(10)
    controller.abort()

    const outcome = await Promise.race([result, sleep(500).then(() => 'still waiting')])
    expect(outcome).toMatchObject({ error: expect.stringContaining('stopped') })
    expect(kills).toEqual(['call-1'])
  })
})
