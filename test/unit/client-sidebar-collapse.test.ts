// @vitest-environment happy-dom
import { createApp, h, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it, vi } from 'vitest'
import AppSidebar from '@/client/components/layout/app-sidebar.vue'
import { useSyncStore } from '@/client/stores/sync'
import { SidebarProvider } from '@/client/ui/sidebar'
import type { Project, Conversation } from '@/shared/models'

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

it('keeps a collapsed desktop sidebar as an expandable icon rail', async () => {
  useDesktopViewport()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  })
  await router.push('/new')

  const pinia = createPinia()
  const sync = useSyncStore(pinia)
  const project: Project = { id: 7, user_id: 1, name: 'Design', icon_attachment_id: null, system_prompt: null, provider_id: null, model_id: null, params: null, created_at: 0, updated_at: 0 }
  const conversation: Conversation = { id: 12, user_id: 1, project_id: null, title: 'Notes', head_message_id: null, provider_id: null, model_id: null, system_prompt: null, params: null, tools: [], archived_at: null, created_at: 0, updated_at: 0 }
  sync.projects.set(project.id, project)
  sync.conversations.set(conversation.id, conversation)
  sync.projectsLoaded = true
  sync.conversationsLoaded = true

  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({
    render: () => h(SidebarProvider, { defaultOpen: false }, () => h(AppSidebar)),
  }).use(pinia).use(router)
  app.mount(host)
  cleanup = () => app.unmount()

  const sidebar = document.querySelector<HTMLElement>('[data-slot="sidebar"][data-state="collapsed"]')
  expect(sidebar?.dataset.collapsible).toBe('icon')
  expect(document.querySelector('[data-connection-status]')).not.toBeNull()

  const rail = document.querySelector<HTMLButtonElement>('[data-slot="sidebar-rail"]')
  expect(rail).not.toBeNull()
  expect(document.querySelector('a[href="/c/12"] svg')).not.toBeNull()
  rail!.click()
  await nextTick()

  expect(sidebar?.dataset.state).toBe('expanded')
  expect(sidebar?.dataset.collapsible).toBe('')
})
