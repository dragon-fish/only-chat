// @vitest-environment happy-dom
import { createApp, h, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it, vi } from 'vitest'
import ProjectCreateDialog from '@/client/components/layout/project-create-dialog.vue'
import { useSyncStore } from '@/client/stores/sync'

let cleanup = () => {}
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.innerHTML = '' })

it('opens the project that the create command produced', async () => {
  const pinia = createPinia()
  const sync = useSyncStore(pinia)
  sync.status = 'open'
  vi.spyOn(sync, 'send').mockReturnValue(true)
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/project/:id', component: { template: '<div />' } },
  ] })
  await router.push('/')
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ render: () => h(ProjectCreateDialog) }).use(pinia).use(router)
  app.mount(host)
  cleanup = () => app.unmount()

  host.querySelector<HTMLButtonElement>('button')!.click()
  await vi.waitFor(() => expect(document.querySelector('#oc-new-project-name')).not.toBeNull())
  const input = document.querySelector<HTMLInputElement>('#oc-new-project-name')!
  input.value = 'Long context'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  sync.applyEvent({
    type: 'project.created',
    project: { id: 42, user_id: 1, name: 'Long context', system_prompt: null, provider_id: null, model_id: null, params: null, created_at: 1, updated_at: 1 },
  })
  await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/project/42'))
})
