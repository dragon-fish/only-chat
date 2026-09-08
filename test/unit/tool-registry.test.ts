import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import { ToolRegistry, ToolRegistryPlugin } from '@/server/plugins/tools'
import { AskUserServerPlugin } from '@/plugins/ask-user/server'

const registeredTool = (description: string) => tool({ description, inputSchema: z.object({}) })

describe('ToolRegistry', () => {
  it('resolves only enabled, known tools in stable ID order', () => {
    const registry = new ToolRegistry(new Context())
    registry.register('plugin-a', 'z', () => registeredTool('z'))
    registry.register('plugin-a', 'a', () => registeredTool('a'))
    expect(registry.resolve(['z', 'a'], { 'plugin-a': true }).map(([id]) => id)).toEqual(['a', 'z'])
    expect(() => registry.resolve(['missing'], { 'plugin-a': true })).toThrow(/unknown tool/i)
    expect(registry.resolve(['a'], { 'plugin-a': false })).toEqual([])
  })

  it('removes registrations through their disposer', () => {
    const registry = new ToolRegistry(new Context())
    const dispose = registry.register('ask_user', 'ask_user', () => registeredTool('ask'))
    dispose()
    expect(() => registry.resolve(['ask_user'], { ask_user: true })).toThrow(/unknown tool/i)
  })

  it('registers ask_user as a non-executing AI SDK tool', async () => {
    const ctx = new Context()
    await ctx.plugin(ToolRegistryPlugin)
    await ctx.plugin(AskUserServerPlugin)
    const [[id, askUser]] = ctx.tools.resolve(['ask_user'], { ask_user: true })
    expect(id).toBe('ask_user')
    expect(askUser.execute).toBeUndefined()
  })
})
