// @vitest-environment happy-dom
import { createApp, h } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ToolSelector from '@/client/components/tool-selector.vue'
import { TooltipProvider } from '@/client/ui/tooltip'
import {
  availablePluginRows,
  defaultToolsForSettings,
  ensureSelectedPlugins,
  nextToolSelection,
  conversationToolBlockReason,
} from '@/client/components/tool-selector'

const manifests = [
  {
    id: 'zeta',
    name: 'Zeta',
    description: 'Z',
    tools: [
      { id: 'z_search', name: 'z_search', description: 'search' },
      { id: 'z_extract', name: 'z_extract', description: 'extract' },
    ],
  },
  { id: 'ask_user', name: 'Ask User', description: 'Ask', tools: [{ id: 'ask_user', name: 'ask_user', description: 'ask_user' }] },
]

describe('conversation tool selection', () => {
  it('defaults a new draft to tools from globally enabled manifests in stable order', () => {
    expect(defaultToolsForSettings(manifests, { ask_user: true })).toEqual(['ask_user'])
    expect(defaultToolsForSettings(manifests, { ask_user: true, zeta: true })).toEqual(['ask_user', 'z_extract', 'z_search'])
  })

  it('offers one row per plugin, because companion tools are useless apart', () => {
    const rows = availablePluginRows(manifests, { ask_user: true, zeta: true }, ['z_search'])
    expect(rows).toEqual([
      expect.objectContaining({ id: 'ask_user', toolIds: ['ask_user'], selected: false }),
      expect.objectContaining({ id: 'zeta', toolIds: ['z_search', 'z_extract'], selected: true }),
    ])
  })

  it('keeps a globally disabled plugin visible only while this conversation still uses it', () => {
    const rows = availablePluginRows(manifests, { ask_user: false, zeta: false }, ['ask_user'])
    expect(rows).toEqual([expect.objectContaining({ id: 'ask_user', enabled: false, selected: true })])
  })

  it('turns a whole group on or off at once', () => {
    expect(nextToolSelection(['z_search', 'z_extract', 'ask_user'], ['z_search', 'z_extract'], false)).toEqual(['ask_user'])
    // A half-selected snapshot from an older manifest heals the moment its group is switched on.
    expect(nextToolSelection(['z_search'], ['z_search', 'z_extract'], true)).toEqual(['z_extract', 'z_search'])
  })

  it('blocks draft sends until plugin settings have loaded and pending calls until resolved', () => {
    expect(conversationToolBlockReason({ draft: true, settingsLoaded: false, pending: false }))
      .toBe('正在加载插件设置…')
    expect(conversationToolBlockReason({ draft: false, settingsLoaded: true, pending: true }))
      .toBe('请先回答或取消当前问题')
    expect(conversationToolBlockReason({ draft: false, settingsLoaded: true, pending: false })).toBeNull()
  })

  it('consumes lazy plugin load failures and reports them once', async () => {
    const error = new Error('chunk unavailable')
    const report = vi.fn()
    await expect(ensureSelectedPlugins(
      { ensurePlugin: vi.fn().mockRejectedValue(error) },
      ['ask_user', 'ask_user'],
      report,
    )).resolves.toBeUndefined()
    expect(report).toHaveBeenCalledExactlyOnceWith('ask_user', error)
  })

  it.each([
    [true, 'popover-content'],
    [false, 'drawer-content'],
  ] as const)('uses the responsive tool surface (desktop=%s)', async (desktop, slot) => {
    const root = document.createElement('div')
    document.body.append(root)
    const app = createApp({ render: () => h(TooltipProvider, null, { default: () => h(ToolSelector, { modelValue: [], plugins: { ask_user: true }, pluginConfig: {}, desktop, supported: true }) }) })
    app.provide('clientPluginHost', null)
    app.mount(root)
    root.querySelector<HTMLButtonElement>('button[aria-label="选择工具"]')!.click()
    await vi.waitFor(() => expect(document.querySelector(`[data-slot="${slot}"]`)).not.toBeNull())
    app.unmount()
    root.remove()
  })
})

afterEach(() => { document.body.innerHTML = '' })
