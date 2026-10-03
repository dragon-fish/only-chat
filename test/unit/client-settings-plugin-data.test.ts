// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it, vi } from 'vitest'
import SettingsPluginData from '@/client/views/settings-plugin-data.vue'

let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })

const panelFor = (pluginId: string) => defineComponent({ render: () => h('p', { class: 'panel' }, `${pluginId} panel`) })

it('swaps in the other plugin\'s panel when the route moves between two data pages', async () => {
  const header = document.createElement('div')
  header.id = 'page-header'
  const root = document.createElement('div')
  document.body.append(header, root)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] })
  await router.push('/')

  const pluginId = ref('memory')
  const app = createApp({ render: () => h(SettingsPluginData, { pluginId: pluginId.value }) })
    .provide('clientPluginHost', { ensureSettingsPanel: async (id: string) => panelFor(id) })
    .use(router)
  app.mount(root)
  cleanup = () => app.unmount()

  await vi.waitFor(() => expect(root.querySelector('.panel')?.textContent).toBe('memory panel'))
  pluginId.value = 'mcp'
  await nextTick()
  await vi.waitFor(() => expect(root.querySelector('.panel')?.textContent).toBe('mcp panel'))
})
