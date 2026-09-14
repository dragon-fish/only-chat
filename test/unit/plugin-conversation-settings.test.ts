import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { PluginManifest } from '@/shared/plugins'
import { conversationConfigOf, parseConversationPluginSettings, pluginAvailableIn } from '@/shared/plugins'
import { availableToolGroups, defaultToolsForSettings } from '@/client/components/tool-selector'

const scoped: PluginManifest = {
  id: 'scoped',
  name: 'Scoped',
  description: 'needs a project',
  requiresProject: true,
  tools: [{ id: 'scoped_tool', name: 'tool', description: 'tool' }],
  conversationConfigSchema: z.object({ mode: z.enum(['a', 'b']).default('a') }),
  conversationConfig: [{ key: 'mode', label: 'Mode', help: '', type: 'select' }],
}
const plain: PluginManifest = {
  id: 'plain',
  name: 'Plain',
  description: 'works anywhere',
  tools: [{ id: 'plain_tool', name: 'tool', description: 'tool' }],
}

describe('per-conversation plugin settings', () => {
  it('parses each entry through its plugin schema and refuses plugins without one', () => {
    expect(parseConversationPluginSettings([scoped, plain], { scoped: { mode: 'b' } })).toEqual({ scoped: { mode: 'b' } })
    expect(() => parseConversationPluginSettings([scoped, plain], { scoped: { mode: 'zzz' } })).toThrow()
    expect(() => parseConversationPluginSettings([scoped, plain], { plain: { anything: 1 } })).toThrow(/no conversation settings/)
    expect(() => parseConversationPluginSettings([scoped, plain], { unknown: {} })).toThrow(/no conversation settings/)
  })

  it('applies schema defaults when a conversation stored nothing for the plugin', () => {
    expect(conversationConfigOf(scoped, null)).toEqual({ mode: 'a' })
    expect(conversationConfigOf(scoped, { scoped: { mode: 'b' } })).toEqual({ mode: 'b' })
    expect(conversationConfigOf(plain, { plain: { anything: 1 } })).toEqual({})
  })

  it('keeps project-only plugins out of conversations without a Project', () => {
    expect(pluginAvailableIn(scoped, { projectId: null })).toBe(false)
    expect(pluginAvailableIn(scoped, { projectId: 3 })).toBe(true)
    expect(pluginAvailableIn(plain, { projectId: null })).toBe(true)

    const settings = { scoped: true, plain: true }
    expect(defaultToolsForSettings([scoped, plain], settings, {}, { projectId: null })).toEqual(['plain_tool'])
    expect(defaultToolsForSettings([scoped, plain], settings, {}, { projectId: 3 })).toEqual(['plain_tool', 'scoped_tool'])
    expect(availableToolGroups([scoped, plain], settings, [], {}, { projectId: null }).map(row => row.pluginId)).toEqual(['plain'])
    expect(availableToolGroups([scoped, plain], settings, [], {}, { projectId: 3 }).map(row => row.pluginId)).toEqual(['plain', 'scoped'])
  })
})
