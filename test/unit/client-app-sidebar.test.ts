// @vitest-environment happy-dom
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it, vi } from 'vitest'
import AppSidebar from '@/client/components/layout/app-sidebar.vue'
import { useSyncStore } from '@/client/stores/sync'
import { SidebarProvider } from '@/client/ui/sidebar'
import type { Project } from '@/shared/models'

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

async function mountSidebar(path: string, status: 'connecting' | 'open' | 'closed' = 'open') {
  useDesktopViewport()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/new', component: { template: '<div />' } },
      { path: '/project/:projectId', component: { template: '<div />' } },
      { path: '/settings/providers', component: { template: '<div />' } },
      { path: '/:pathMatch(.*)*', component: { template: '<div />' } },
    ],
  })
  await router.push(path)

  const pinia = createPinia()
  const sync = useSyncStore(pinia)
  sync.status = status
  const project: Project = { id: 1, user_id: 1, name: 'Design', system_prompt: null, provider_id: null, model_id: null, params: null, created_at: 0, updated_at: 0 }
  sync.projects.set(project.id, project)
  sync.projectsLoaded = true
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({
    render: () => h(SidebarProvider, null, () => h(AppSidebar)),
  }).use(pinia).use(router)
  app.mount(host)
  cleanup = () => app.unmount()
}

function expectGlobalFrame(status: string) {
  const brand = document.querySelector('[data-sidebar-brand]')
  const connection = document.querySelector('[data-connection-status]')
  expect(brand).not.toBeNull()
  expect(brand!.textContent).toContain('Only Chat')
  expect(connection).not.toBeNull()
  expect(connection!.getAttribute('data-status')).toBe(status)
  expect(document.querySelector('a[href="/settings/providers"]')).not.toBeNull()
  expect(document.body.textContent).toContain('Only Chat User')
}

for (const path of ['/new', '/settings/providers']) {
  it(`keeps the global sidebar frame on ${path}`, async () => {
    await mountSidebar(path)

    expectGlobalFrame('open')
  })
}

it('keeps the global frame around Project contextual navigation', async () => {
  await mountSidebar('/project/1')

  expect(document.body.textContent).toContain('Design')
  expect(document.body.textContent).toContain('Project 新对话')
  expectGlobalFrame('open')
})

it('keeps Project controls in contextual content below the global brand', async () => {
  await mountSidebar('/project/1')

  const brand = document.querySelector('[data-sidebar-brand]')
  const projectContext = document.querySelector('[data-project-context]')
  expect(brand).not.toBeNull()
  expect(projectContext).not.toBeNull()
  expect(brand!.compareDocumentPosition(projectContext!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(document.querySelectorAll('[data-project-back]')).toHaveLength(1)
  expect(document.querySelectorAll('[data-project-switcher]')).toHaveLength(1)
  expect(document.querySelectorAll('[data-project-new-chat]')).toHaveLength(1)
  expect(document.querySelectorAll('[data-project-settings]')).toHaveLength(1)
})

it('keeps settings navigation contextual and activates the global settings link', async () => {
  await mountSidebar('/settings/providers')

  const settingsHeader = document.querySelector('[data-settings-header]')
  const settingsContent = document.querySelector('[data-settings-content]')
  const globalSettings = document.querySelector('[data-global-settings]')
  expect(settingsHeader).not.toBeNull()
  expect(settingsContent).not.toBeNull()
  expect(document.querySelectorAll('[data-sidebar-brand]')).toHaveLength(1)
  expect(document.querySelectorAll('[data-global-settings]')).toHaveLength(1)
  expect(globalSettings?.getAttribute('data-active')).toBe('true')
  expect(settingsHeader!.querySelectorAll('[data-settings-back]')).toHaveLength(1)
  expect(settingsContent!.querySelectorAll('[data-settings-category]')).toHaveLength(3)
  expect(settingsContent!.querySelectorAll('[data-global-settings]')).toHaveLength(0)
})

it('keeps the global settings link active on every settings route', async () => {
  await mountSidebar('/settings/plugins')

  expect(document.querySelector('[data-global-settings]')?.getAttribute('data-active')).toBe('true')
})

it('uses the warning token while reconnecting', async () => {
  await mountSidebar('/new', 'connecting')

  const connection = document.querySelector('[data-connection-status]')
  expect(connection?.getAttribute('data-status')).toBe('connecting')
  expect(connection?.classList.contains('bg-warning')).toBe(true)
})
