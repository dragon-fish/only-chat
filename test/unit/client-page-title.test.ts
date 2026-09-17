// @vitest-environment happy-dom
import { createApp, nextTick, shallowRef } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it, vi } from 'vitest'
import App from '@/client/app.vue'
import { useSyncStore } from '@/client/stores/sync'
import type { Conversation, Project } from '@/shared/models'

vi.mock('@/client/lib/auth-client', () => ({
  authClient: { useSession: () => shallowRef({ isPending: true }) },
}))

let unmount = () => {}

afterEach(() => {
  unmount()
  document.body.innerHTML = ''
  document.title = 'Only Chat'
})

async function mountAt(path: string) {
  const view = { template: '<div />' }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: view, meta: { guestOnly: true } },
      { path: '/login', component: view, meta: { guestOnly: true } },
      { path: '/settings/providers', component: view, meta: { guestOnly: true } },
      { path: '/new', component: view, meta: { guestOnly: true } },
      { path: '/c/:conversationId', component: view, meta: { guestOnly: true } },
      { path: '/project/:projectId/c/:conversationId', component: view, meta: { guestOnly: true } },
    ],
  })
  await router.push(path)
  const pinia = createPinia()
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(App).use(pinia).use(router)
  app.mount(host)
  unmount = () => app.unmount()
  await nextTick()
  return { router, sync: useSyncStore(pinia) }
}

it('uses a page title on navigation and restores the brand title on the default route', async () => {
  document.title = 'Only Chat'
  const { router } = await mountAt('/login')
  expect(document.title).toBe('登录 | Only Chat')

  await router.push('/settings/providers')
  await nextTick()
  expect(document.title).toBe('供应商设置 | Only Chat')

  await router.push('/')
  await nextTick()
  expect(document.title).toBe('Only Chat')
})

it('tracks the current conversation and Project names', async () => {
  document.title = 'Only Chat'
  const { router, sync } = await mountAt('/project/3/c/7')
  const project: Project = { id: 3, user_id: 1, name: '研究', icon_attachment_id: null, system_prompt: null, provider_id: null, model_id: null, params: null, created_at: 1, updated_at: 1 }
  const conversation: Conversation = { id: 7, user_id: 1, project_id: 3, title: '聊天标题', head_message_id: null, provider_id: null, model_id: null, system_prompt: null, params: null, tools: [], tools_enabled: true, created_at: 1, updated_at: 1, archived_at: null }
  sync.projects.set(project.id, project)
  sync.conversations.set(conversation.id, conversation)
  await nextTick()
  expect(document.title).toBe('聊天标题 | 研究 | Only Chat')

  sync.conversations.get(7)!.title = '更新后的标题'
  await nextTick()
  expect(document.title).toBe('更新后的标题 | 研究 | Only Chat')

  await router.push('/new')
  await nextTick()
  expect(document.title).toBe('新对话 | Only Chat')
})
