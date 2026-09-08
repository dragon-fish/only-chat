// @vitest-environment happy-dom
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it, vi } from 'vitest'
import { compile } from 'tailwindcss'
import ProjectNavRow from '@/client/components/layout/project-nav-row.vue'
import SessionNavRow from '@/client/components/layout/session-nav-row.vue'
import { SidebarMenu, SidebarProvider } from '@/client/ui/sidebar'
import { useSyncStore } from '@/client/stores/sync'
import type { Project, Session } from '@/shared/models'

let cleanup = () => {}
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.innerHTML = '' })

async function mountRows(options: { mobile?: boolean } = {}) {
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({
    matches: options.mobile === true && query === '(max-width: 767px)',
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }))
  const pinia = createPinia()
  const sync = useSyncStore(pinia)
  const project: Project = { id: 7, user_id: 1, name: 'Design', icon_attachment_id: null, system_prompt: null, provider_id: null, model_id: null, params: null, created_at: 0, updated_at: 0 }
  const session: Session = { id: 12, user_id: 1, project_id: 7, title: 'Notes', head_message_id: null, provider_id: null, model_id: null, system_prompt: null, params: null, archived_at: null, created_at: 0, updated_at: 0 }
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push('/project/7')
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ render: () => h(SidebarProvider, null, () => h(SidebarMenu, null, () => [
    h(ProjectNavRow, { project }),
    h(SessionNavRow, { session, projects: [project, { ...project, id: 8, name: 'Research' }] }),
  ])) }).use(pinia).use(router)
  app.mount(host)
  cleanup = () => app.unmount()
  return vi.spyOn(sync, 'send').mockReturnValue(true)
}

function menuItem(text: string) {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === text)!
}

async function applyActionStyles(actions: HTMLElement[]) {
  const compiler = await compile('@theme inline { --spacing: 0.25rem; --breakpoint-md: 48rem; } @tailwind utilities;')
  const stylesheet = document.createElement('style')
  // happy-dom cannot match sibling combinators inside :is(). Unfold the equivalent
  // selector while preserving specificity so the primitive's peer rules participate.
  stylesheet.textContent = compiler.build(actions.flatMap(action => [...action.classList]))
    .replace(/([^\n{}]+):is\((:where\([^)]*\)\[data-size="[^"]+"\]) ~ \*\)/g, '$2 ~ $1')
  document.body.append(stylesheet)
}

it.each([
  ['desktop', false],
  ['mobile', true],
])('keeps %s row actions large enough while preserving 16px icons', async (_, mobile) => {
  await mountRows({ mobile })

  const actions = [...document.querySelectorAll<HTMLElement>('[data-row-action]')]
  await applyActionStyles(actions)
  expect(actions).toHaveLength(2)
  for (const action of actions) {
    expect(action.classList).toContain('size-8')
    expect(action.classList).toContain('w-8')
    expect(action.classList).toContain('h-8')
    expect(action.classList).toContain('max-md:size-10')
    expect(['50%', 'calc(1 / 2 * 100%)']).toContain(getComputedStyle(action).top)
    expect(action.classList).toContain('-translate-y-1/2')
    expect(action.classList).toContain('after:inset-0')
    expect(action.querySelector('svg')?.classList).toContain('size-4')
  }
})

it('offers session movement and confirmed deletion from one row action menu', async () => {
  const send = await mountRows()
  const actions = document.querySelector<HTMLButtonElement>('[aria-label="对话操作：Notes"]')
  expect(actions).not.toBeNull()
  actions!.click()
  await vi.waitFor(() => expect(menuItem('移动到')).toBeDefined())
  expect(menuItem('删除对话')).toBeDefined()
  menuItem('移动到').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  await vi.waitFor(() => expect(menuItem('Research')).toBeDefined())
  menuItem('Research').click()
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'session.update', session_id: 12, project_id: 8 }))
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
  send.mockClear()
  actions!.click()
  await vi.waitFor(() => expect(menuItem('删除对话')).toBeDefined())
  menuItem('删除对话').click()
  await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
  expect(send).not.toHaveBeenCalled()
  ;[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '取消')!.click()
  await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull())
  expect(send).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(document.activeElement === actions).toBe(true))
  actions!.click()
  await vi.waitFor(() => expect(menuItem('删除对话')).toBeDefined())
  menuItem('删除对话').click()
  await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
  ;[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '删除')!.click()
  expect(send).toHaveBeenCalledWith({ type: 'session.delete', session_id: 12 })
})

it('requires Project deletion confirmation after opening its row action menu', async () => {
  const send = await mountRows()
  const actions = document.querySelector<HTMLButtonElement>('[aria-label="Project 操作：Design"]')
  expect(actions).not.toBeNull()
  actions!.click()
  await vi.waitFor(() => expect(menuItem('删除 Project')).toBeDefined())
  menuItem('删除 Project').click()
  await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
  expect(send).not.toHaveBeenCalled()
  ;[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '删除')!.click()
  expect(send).toHaveBeenCalledWith({ type: 'project.delete', project_id: 7 })
})
