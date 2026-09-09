// @vitest-environment happy-dom
import { createApp, h, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { routes } from 'vue-router/auto-routes'
import { SidebarProvider } from '@/client/ui/sidebar'
import { useSyncStore } from '@/client/stores/sync'
import { useConfigStore } from '@/client/stores/config'
import { afterEach, expect, it, vi } from 'vitest'

let cleanup = () => {}
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.innerHTML = '' })

async function mountSettings() {
  const pinia = createPinia()
  const sync = useSyncStore(pinia)
  useConfigStore(pinia).loaded = true
  sync.projects.set(7, { id: 7, user_id: 1, name: 'Design', icon_attachment_id: null, system_prompt: null, provider_id: null, model_id: null, params: null, created_at: 0, updated_at: 1 })
  sync.projectsLoaded = sync.conversationsLoaded = true
  sync.status = 'open'
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/project/7/settings')
  document.body.innerHTML = '<header id="page-header"></header><main id="test-host"></main>'
  const app = createApp({ render: () => h(SidebarProvider, null, () => h(RouterView)) }).use(pinia).use(router)
  app.mount('#test-host')
  cleanup = () => app.unmount()
  await vi.waitFor(() => expect(document.querySelector('#oc-project-name')).not.toBeNull())
  return { sync, router }
}

async function editName() {
  const input = document.querySelector<HTMLInputElement>('#oc-project-name')!
  input.value = 'Unsaved Project'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  return input
}

it('keeps Project edits when dialog dismissal is cancelled and returns to its workspace after discard', async () => {
  const { router } = await mountSettings()
  const input = await editName()
  input.focus()
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
  ;[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '继续编辑')!.click()
  await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull())
  expect(router.currentRoute.value.path).toBe('/project/7/settings')
  expect(document.querySelector<HTMLInputElement>('#oc-project-name')!.value).toBe('Unsaved Project')
  const refresh = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(refresh)
  expect(refresh.defaultPrevented).toBe(true)
  input.focus()
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
  ;[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '放弃更改')!.click()
  await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/project/7'))
})

it('waits for a successful Project acknowledgement before returning to the workspace', async () => {
  const { router, sync } = await mountSettings()
  await editName()
  const send = vi.spyOn(sync, 'send').mockReturnValue(true)
  ;[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '保存')!.click()
  await nextTick()
  expect(router.currentRoute.value.path).toBe('/project/7/settings')
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'project.update', project_id: 7, name: 'Unsaved Project' }))
  sync.projects.set(7, { ...sync.projects.get(7)!, name: 'Unsaved Project', updated_at: 2 })
  await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/project/7'))
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
})
