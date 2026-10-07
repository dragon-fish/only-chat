// @vitest-environment happy-dom
import { createApp, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it } from 'vitest'
import SettingsAbout from '@/client/views/settings-about.vue'

let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })

it('keeps the licence-required attribution, linked upstream', async () => {
  // ATTRIBUTION.md (AGPL section 7(b)) makes this line a licence term, not decoration.
  const header = document.createElement('div')
  header.id = 'page-header'
  const root = document.createElement('div')
  document.body.append(header, root)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] })
  await router.push('/')
  const app = createApp({ render: () => h(SettingsAbout) }).use(router)
  app.mount(root)
  cleanup = () => app.unmount()
  await nextTick()

  const attribution = root.querySelector<HTMLAnchorElement>('a[data-attribution]')
  expect(attribution?.textContent?.trim()).toBe('Powered by Only Chat')
  expect(attribution?.href).toBe('https://github.com/dragon-fish/only-chat')
})
