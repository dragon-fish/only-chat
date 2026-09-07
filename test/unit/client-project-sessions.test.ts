// @vitest-environment happy-dom
import { createApp, h, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it, vi } from 'vitest'
import ProjectSessions from '@/client/views/project-sessions.vue'
import { SidebarProvider } from '@/client/ui/sidebar'
import { useSyncStore } from '@/client/stores/sync'
import type { Project, Session } from '@/shared/models'

let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })

it('filters the current Project only and restores its full list when search is cleared', async () => {
  // A missing query binding leaves all rows visible; losing the Project scope leaks other chats.
  const pinia = createPinia()
  const sync = useSyncStore(pinia)
  const project: Project = { id: 7, user_id: 1, name: 'Design', system_prompt: null, provider_id: null, model_id: null, params: null, created_at: 0, updated_at: 0 }
  const session = (id: number, title: string, project_id: number | null): Session => ({ id, user_id: 1, title, project_id, head_message_id: null, provider_id: null, model_id: null, system_prompt: null, params: null, archived_at: null, created_at: 0, updated_at: id })
  sync.projects.set(7, project)
  sync.projectsLoaded = true
  sync.sessionsLoaded = true
  for (const value of [session(1, 'Design notes', 7), session(2, 'Release', 7), session(3, 'Design elsewhere', 8), session(4, 'Design free chat', null)]) sync.sessions.set(value.id, value)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push('/project/7')
  document.body.innerHTML = '<header id="page-header"></header><main id="test-host"></main>'
  const app = createApp({ render: () => h(SidebarProvider, null, () => h(ProjectSessions, { projectId: 7 })) }).use(pinia).use(router)
  app.mount('#test-host')
  cleanup = () => app.unmount()
  const links = () => [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/c/"]')].map(link => link.getAttribute('href'))
  const search = document.querySelector<HTMLInputElement>('input[aria-label="搜索 Project 内对话"]')
  expect(search).not.toBeNull()
  search!.value = ' DESIGN '
  search!.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  expect(links()).toEqual(['/project/7/c/1'])
  search!.value = 'missing'
  search!.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  expect(links()).toEqual([])
  const clear = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '清除搜索')
  expect(clear).toBeDefined()
  clear!.click()
  await vi.waitFor(() => expect(links()).toEqual(['/project/7/c/2', '/project/7/c/1']))
  expect(search!.value).toBe('')
})
