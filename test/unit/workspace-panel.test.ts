import { describe, expect, it } from 'vitest'
import { shouldOpenForAttention } from '@/client/composables/use-workspace-panel'
import { ClientPluginHost } from '@/client/plugins/host'
import { workspaceTabs, type PluginManifest } from '@/shared/plugins'

const manifest = (id: string, extra: Partial<PluginManifest> = {}): PluginManifest => ({
  id, name: id, description: id, tools: [{ id: `${id}_tool`, name: id, description: id }], ...extra,
})

describe('workspace panel', () => {
  it('opens once on its own, never over a person who closed it, always for a handoff', () => {
    const base = { open: false, userCollapsed: false, autoOpened: false, force: false }
    expect(shouldOpenForAttention(base)).toBe(true)
    expect(shouldOpenForAttention({ ...base, autoOpened: true })).toBe(false)
    expect(shouldOpenForAttention({ ...base, userCollapsed: true })).toBe(false)
    expect(shouldOpenForAttention({ ...base, open: true })).toBe(false)
    expect(shouldOpenForAttention({ ...base, autoOpened: true, userCollapsed: true, force: true })).toBe(true)
  })

  it('lists tabs only for enabled plugins that can serve the conversation', () => {
    const manifests = [
      manifest('files', { workspaceTab: { label: '文件' } }),
      manifest('browser', { workspaceTab: { label: '浏览器' }, requiresProject: true }),
      manifest('search'),
    ]
    const settings = { files: true, browser: true, search: true }
    expect(workspaceTabs(manifests, settings, { projectId: null })).toEqual([{ pluginId: 'files', label: '文件' }])
    expect(workspaceTabs(manifests, settings, { projectId: 4 }).map(tab => tab.pluginId)).toEqual(['files', 'browser'])
    expect(workspaceTabs(manifests, { files: false, browser: true }, { projectId: 4 }).map(tab => tab.pluginId)).toEqual(['browser'])
  })

  it('hands a plugin its own panel and forwards its attention to the shell', async () => {
    const seen: Array<[string, unknown]> = []
    const host = new ClientPluginHost({
      manifests: [manifest('files')],
      loaders: { files: async () => ({ setup: (ctx) => {
        ctx.workspacePanel.register({ name: 'tab' })
        ctx.workspacePanel.attention({ force: true })
      } }) },
    })
    const stop = host.onWorkspaceAttention((pluginId, request) => seen.push([pluginId, request]))
    expect(await host.ensureWorkspacePanel('files')).toEqual({ name: 'tab' })
    expect(seen).toEqual([['files', { force: true }]])
    stop()
    host.disposePlugin('files')
    expect(host.workspacePanel('files')).toBeUndefined()
  })
})
