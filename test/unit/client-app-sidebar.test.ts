// @vitest-environment happy-dom
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it, vi } from 'vitest'
import AppSidebar from '@/client/components/layout/app-sidebar.vue'
import { useSyncStore } from '@/client/stores/sync'
import { useAuthStore } from '@/client/stores/auth'
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

async function mountSidebar(path: string, status: 'connecting' | 'open' | 'closed' = 'open', defaultOpen = true) {
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
  useAuthStore(pinia).authUser = { id: '2', name: 'Sidebar Person', email: 'sidebar@example.com', role: 'user', banned: false, emailVerified: false, createdAt: new Date(), updatedAt: new Date() }
  const sync = useSyncStore(pinia)
  sync.status = status
  const project: Project = { id: 1, user_id: 1, name: 'Design', icon_attachment_id: null, system_prompt: null, provider_id: null, model_id: null, params: null, created_at: 0, updated_at: 0 }
  sync.projects.set(project.id, project)
  sync.projectsLoaded = true
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({
    render: () => h(SidebarProvider, { defaultOpen }, () => h(AppSidebar)),
  }).use(pinia).use(router)
  app.mount(host)
  cleanup = () => app.unmount()
  return { router, sync }
}

function expectGlobalFrame(status: string) {
  const brand = document.querySelector('[data-sidebar-brand]')
  const connection = document.querySelector('[data-connection-status]')
  expect(brand).not.toBeNull()
  expect(brand!.textContent).toContain('Only Chat')
  expect(connection).not.toBeNull()
  expect(connection!.getAttribute('data-status')).toBe(status)
  // The data attribute, not the href: the settings entry's target has moved once already, and
  // what this asserts is that the global frame is present, not where its link points.
  expect(document.querySelector('[data-global-settings]')).not.toBeNull()
  expect(document.body.textContent).toContain('Sidebar Person')
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

it('uses the global sidebar for image navigation instead of duplicating chat navigation', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([])))
  await mountSidebar('/images/new')
  await vi.waitFor(() => expect(document.querySelector('[data-image-context]')).not.toBeNull())
  expect(document.body.textContent).toContain('图片 Gallery')
  expect(document.body.textContent).not.toContain('Projects')
  expectGlobalFrame('open')
})

it('updates image history from realtime conversation events', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([])))
  const { sync } = await mountSidebar('/images/new')
  await vi.waitFor(() => expect(document.body.textContent).toContain('还没有创作历史'))

  sync.applyEvent({ type: 'conversation.created', conversation: {
    id: 21, user_id: 2, project_id: null, title: '白毛红瞳兽耳娘', kind: 'image', head_message_id: 1,
    provider_id: null, model_id: null, image_provider_id: 4, image_model_id: 'seedream',
    system_prompt: null, params: null, tools: [], tools_enabled: true, created_at: 1, updated_at: 1, archived_at: null,
  } })

  await vi.waitFor(() => expect(document.body.textContent).toContain('白毛红瞳兽耳娘'))

  sync.applyEvent({ type: 'conversation.deleted', conversation_id: 21 })
  await vi.waitFor(() => expect(document.body.textContent).toContain('还没有创作历史'))
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
  expect(settingsContent!.querySelector('a[href="/settings/account"]')).not.toBeNull()
  expect(settingsContent!.querySelectorAll('[data-global-settings]')).toHaveLength(0)
})

it('keeps the global settings link active on the plugins settings route', async () => {
  await mountSidebar('/settings/plugins')

  expect(document.querySelector('[data-global-settings]')?.getAttribute('data-active')).toBe('true')
})

for (const collapsed of [false, true]) {
  it.each([
    ['open', '服务器已连接'],
    ['connecting', '正在连接服务器'],
    ['closed', '服务器连接已断开，正在重试'],
  ] as const)(`reveals the %s status on keyboard focus and hover when ${collapsed ? 'collapsed' : 'expanded'}`, async (status, label) => {
    await mountSidebar('/settings/providers', status, !collapsed)

    const connection = document.querySelector<HTMLElement>('[data-connection-status]')!
    connection.focus()
    await vi.waitFor(() => {
      const content = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]:not([hidden])')
      expect(content).not.toBeNull()
      expect(content!.textContent).toContain(label)
    })
    expect(connection.closest('a')).toBeNull()
    expect(document.getElementById(connection.getAttribute('aria-describedby')!)?.textContent).toContain(label)

    connection.blur()
    await vi.waitFor(() => expect(document.querySelector('[data-slot="tooltip-content"]:not([hidden])')).toBeNull())
    connection.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', bubbles: true }))
    await vi.waitFor(() => {
      const content = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]:not([hidden])')
      expect(content).not.toBeNull()
      expect(content!.textContent).toContain(label)
    })
  })
}

it('uses the warning token while reconnecting', async () => {
  await mountSidebar('/new', 'connecting')

  const connection = document.querySelector('[data-connection-status]')
  expect(connection?.getAttribute('data-status')).toBe('connecting')
  expect(connection?.querySelector('.bg-warning')).not.toBeNull()
})
