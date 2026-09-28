import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import { ToolRegistry, ToolRegistryPlugin, type ToolContext } from '@/server/plugins/tools'
import { AskUserServerPlugin } from '@/plugins/ask-user/server'
import { TavilyServerPlugin } from '@/plugins/tavily/server'
import { EDIT_FILE_TOOL_ID, READ_FILE_TOOL_ID, TAVILY_PLUGIN_ID, WORKSPACE_FILES_PLUGIN_ID, WRITE_FILE_TOOL_ID } from '@/shared/plugins'

const registeredTool = (description: string) => tool({ description, inputSchema: z.object({}) })

/** Stands in for the PluginConfig service; `configs` maps plugin id to what `read` would return. */
function contextWith(configs: Record<string, Record<string, unknown> | Error> = {}): Context {
  const ctx = new Context()
  ctx.provide('pluginConfig', {
    readIfConfigurable: async (_userId: number, pluginId: string) => {
      const entry = configs[pluginId] ?? {}
      if (entry instanceof Error) throw entry
      return entry
    },
  })
  return ctx
}

const resolution = {
  userId: 1,
  conversationId: 7,
  projectId: null,
  assistantMessageId: 42,
  turn: new Map<string, unknown>(),
  db: {} as ToolContext['db'],
  assets: {} as ToolContext['assets'],
  signal: new AbortController().signal,
  pluginSettings: null,
  acceptsImages: false,
  toolIds: [],
  files: {} as ToolContext['files'],
  acceptsToolResultImages: false,
  publicOrigin: 'https://chat.test',
  path: [],
}

describe('ToolRegistry', () => {
  it('resolves only enabled, known tools in stable ID order', async () => {
    const registry = new ToolRegistry(contextWith())
    registry.register('plugin-a', 'z', () => registeredTool('z'))
    registry.register('plugin-a', 'a', () => registeredTool('a'))
    expect((await registry.resolve(['z', 'a'], { 'plugin-a': true }, resolution)).map(([id]) => id)).toEqual(['a', 'z'])
    await expect(registry.resolve(['missing'], { 'plugin-a': true }, resolution)).rejects.toThrow(/unknown tool/i)
    expect(await registry.resolve(['a'], { 'plugin-a': false }, resolution)).toEqual([])
  })

  it('resolves a snapshot by group, so a tool added later is not withheld', () => {
    const registry = new ToolRegistry(contextWith())
    registry.register(WORKSPACE_FILES_PLUGIN_ID, READ_FILE_TOOL_ID, () => registeredTool('read'))
    registry.register(WORKSPACE_FILES_PLUGIN_ID, WRITE_FILE_TOOL_ID, () => registeredTool('write'))
    registry.register(WORKSPACE_FILES_PLUGIN_ID, EDIT_FILE_TOOL_ID, () => registeredTool('edit'))

    // The selector has no per-tool switch: a conversation whose snapshot predates a tool never
    // deselected it, because it did not exist yet. Withholding it would strand old conversations.
    const usable = registry.usable([READ_FILE_TOOL_ID], { [WORKSPACE_FILES_PLUGIN_ID]: true }, { projectId: null })
    expect(usable).toContain(EDIT_FILE_TOOL_ID)
    expect(usable).toContain(WRITE_FILE_TOOL_ID)
  })

  it('leaves a plugin that declares no manifest resolving by exact id', () => {
    const registry = new ToolRegistry(contextWith())
    registry.register('plugin-a', 'a', () => registeredTool('a'))
    registry.register('plugin-a', 'b', () => registeredTool('b'))
    expect(registry.usable(['a'], { 'plugin-a': true }, { projectId: null })).toEqual(['a'])
  })

  it('removes registrations through their disposer', async () => {
    const registry = new ToolRegistry(contextWith())
    const dispose = registry.register('ask_user', 'ask_user', () => registeredTool('ask'))
    dispose()
    await expect(registry.resolve(['ask_user'], { ask_user: true }, resolution)).rejects.toThrow(/unknown tool/i)
  })

  it('hands each factory its own plugin configuration and one shared per-turn map', async () => {
    const registry = new ToolRegistry(contextWith({ 'plugin-a': { token: 'secret' } }))
    const seen: ToolContext[] = []
    registry.register('plugin-a', 'a', (toolCtx) => { seen.push(toolCtx); return registeredTool('a') })
    registry.register('plugin-a', 'b', (toolCtx) => { seen.push(toolCtx); return registeredTool('b') })
    await registry.resolve(['a', 'b'], { 'plugin-a': true }, resolution)
    expect(seen.map(entry => entry.config)).toEqual([{ token: 'secret' }, { token: 'secret' }])
    expect(seen[0]!.turn).toBe(seen[1]!.turn)
  })

  it('fails the whole resolution when a selected plugin is not configured', async () => {
    const registry = new ToolRegistry(contextWith({ 'plugin-a': new Error('请填写 API Key') }))
    registry.register('plugin-a', 'a', () => registeredTool('a'))
    await expect(registry.resolve(['a'], { 'plugin-a': true }, resolution)).rejects.toThrow(/API Key/)
  })

  it('hands each factory the generation it belongs to', async () => {
    const registry = new ToolRegistry(contextWith())
    const seen: ToolContext[] = []
    registry.register('files', 'read_file', (toolCtx) => { seen.push(toolCtx); return registeredTool('read') })
    const signal = new AbortController().signal
    await registry.resolve(['read_file'], { files: true }, { ...resolution, conversationId: 9, projectId: 3, assistantMessageId: 55, signal })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ userId: 1, conversationId: 9, projectId: 3, assistantMessageId: 55 })
    expect(seen[0]!.signal).toBe(signal)
  })

  it('reports which selected tools are usable without building them', () => {
    const registry = new ToolRegistry(contextWith())
    let built = 0
    registry.register('files', 'read_file', () => { built += 1; return registeredTool('read') })
    registry.register('other', 'nope', () => registeredTool('nope'))
    // The capability check runs before there is an assistant message to build against.
    expect(registry.usable(['read_file', 'nope'], { files: true, other: false }, { projectId: null })).toEqual(['read_file'])
    expect(built).toBe(0)
  })

  it('registers ask_user as a non-executing AI SDK tool', async () => {
    const ctx = contextWith()
    await ctx.plugin(ToolRegistryPlugin)
    await ctx.plugin(AskUserServerPlugin)
    const [[id, askUser]] = await ctx.tools.resolve(['ask_user'], { ask_user: true }, resolution)
    expect(id).toBe('ask_user')
    expect(askUser.execute).toBeUndefined()
  })

  it('registers both Tavily tools as executing tools', async () => {
    const ctx = contextWith({ [TAVILY_PLUGIN_ID]: { api_key: 'k', search_depth: 'basic', search_calls_per_turn: 3, extract_calls_per_turn: 2 } })
    await ctx.plugin(ToolRegistryPlugin)
    await ctx.plugin(TavilyServerPlugin)
    const resolved = await ctx.tools.resolve(['web_search', 'web_extract'], { [TAVILY_PLUGIN_ID]: true }, resolution)
    expect(resolved.map(([id]) => id)).toEqual(['web_extract', 'web_search'])
    expect(resolved.every(([, entry]) => typeof entry.execute === 'function')).toBe(true)
  })
})
