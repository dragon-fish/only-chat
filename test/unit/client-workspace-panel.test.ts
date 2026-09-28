// @vitest-environment happy-dom
import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it, vi } from 'vitest'
import WorkspaceFilePanel from '@/client/components/workspace-file-panel.vue'
import { api } from '@/client/lib/api'

let cleanup = () => {}
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.innerHTML = '' })

it('shows read-only attachment folders and opens audio without text-file APIs', async () => {
  vi.spyOn(api, 'conversationFiles').mockResolvedValue({ files: [], projectFiles: [], projectId: null,
    uploads: [{ path: '/uploads/38.mp3', attachmentId: 38, mime: 'audio/mpeg', size: 1024, width: null, height: null, createdAt: 0 }], artifacts: [],
  })
  const textPreview = vi.spyOn(api, 'workspaceFile')
  const host = document.createElement('div')
  document.body.append(host)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] })
  await router.push('/')
  const app = createApp(WorkspaceFilePanel, { mount: 'conversation', scopeId: 30 }).use(createPinia()).use(router)
  app.mount(host)
  cleanup = () => app.unmount()
  await vi.waitFor(() => expect(host.textContent).toContain('/uploads'))
  expect(host.textContent).toContain('/artifacts')
  const file = host.querySelector<HTMLButtonElement>('[title="/uploads/38.mp3"]')!
  expect(file).not.toBeNull()
  expect(host.querySelector('[aria-label="删除 38.mp3"]')).toBeNull()
  file.click()
  await nextTick()
  await vi.waitFor(() => expect(document.querySelector('audio')?.getAttribute('src')).toBe('/api/attachments/38'))
  expect(textPreview).not.toHaveBeenCalled()
})
