// @vitest-environment happy-dom
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it, vi } from 'vitest'
import AppSidebar from '@/client/components/layout/app-sidebar.vue'
import { useSyncStore } from '@/client/stores/sync'
import { SidebarProvider } from '@/client/ui/sidebar'

let cleanup = () => {}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

function useDesktopViewport() {
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({
    matches: query === '(min-width: 768px)',
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

async function mountSidebar(path: string) {
  useDesktopViewport()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  })
  await router.push(path)

  const pinia = createPinia()
  const sync = useSyncStore(pinia)
  sync.status = 'open'
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({
    render: () => h(SidebarProvider, null, () => h(AppSidebar)),
  }).use(pinia).use(router)
  app.mount(host)
  cleanup = () => app.unmount()
}

for (const path of ['/new', '/project/1', '/settings/providers']) {
  it(`keeps the global sidebar frame on ${path}`, async () => {
    await mountSidebar(path)

    const brand = document.querySelector('[data-sidebar-brand]')
    const connection = document.querySelector('[data-connection-status]')
    expect(brand).not.toBeNull()
    expect(brand!.textContent).toContain('Only Chat')
    expect(connection).not.toBeNull()
    expect(connection!.getAttribute('data-status')).toBe('open')
    expect(document.querySelector('a[href="/settings/providers"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Only Chat User')
  })
}
