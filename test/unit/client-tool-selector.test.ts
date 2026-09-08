// @vitest-environment happy-dom
import { createApp, h } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ToolSelector from '@/client/components/tool-selector.vue'
import { TooltipProvider } from '@/client/ui/tooltip'
import {
  availablePluginRows,
  defaultToolsForSettings,
  nextToolSelection,
  toolSelectionSupported,
} from '@/client/components/tool-selector'

const manifests = [
  { id: 'zeta', name: 'Zeta', description: 'Z', defaultTools: ['z_tool'] },
  { id: 'ask_user', name: 'Ask User', description: 'Ask', defaultTools: ['ask_user'] },
]

describe('session tool selection', () => {
  it('defaults a new draft to tools from globally enabled manifests in stable order', () => {
    expect(defaultToolsForSettings(manifests, { ask_user: true })).toEqual(['ask_user'])
    expect(defaultToolsForSettings(manifests, { ask_user: true, zeta: true })).toEqual(['ask_user', 'z_tool'])
  })

  it('retains an existing snapshot while globally disabled tools become unavailable', () => {
    const rows = availablePluginRows(manifests, { ask_user: false }, ['ask_user'])
    expect(rows).toEqual([
      expect.objectContaining({ id: 'ask_user', enabled: false, selected: true }),
      expect.objectContaining({ id: 'z_tool', enabled: false, selected: false }),
    ])
  })

  it('produces sorted unique snapshots when a tool is toggled', () => {
    expect(nextToolSelection(['z_tool', 'ask_user', 'ask_user'], 'z_tool', false)).toEqual(['ask_user'])
    expect(nextToolSelection(['z_tool'], 'ask_user', true)).toEqual(['ask_user', 'z_tool'])
  })

  it('blocks an active tool selection on a model without tool-call capability', () => {
    expect(toolSelectionSupported(['ask_user'], new Set(['ask_user']), false)).toBe(false)
    expect(toolSelectionSupported(['ask_user'], new Set(), false)).toBe(true)
    expect(toolSelectionSupported(['ask_user'], new Set(['ask_user']), true)).toBe(true)
  })

  it.each([
    [true, 'popover-content'],
    [false, 'drawer-content'],
  ] as const)('uses the responsive tool surface (desktop=%s)', async (desktop, slot) => {
    const root = document.createElement('div')
    document.body.append(root)
    const app = createApp({ render: () => h(TooltipProvider, null, { default: () => h(ToolSelector, { modelValue: [], plugins: { ask_user: true }, desktop }) }) })
    app.provide('clientPluginHost', null)
    app.mount(root)
    root.querySelector<HTMLButtonElement>('button[aria-label="选择工具"]')!.click()
    await vi.waitFor(() => expect(document.querySelector(`[data-slot="${slot}"]`)).not.toBeNull())
    app.unmount()
    root.remove()
  })
})

afterEach(() => { document.body.innerHTML = '' })
