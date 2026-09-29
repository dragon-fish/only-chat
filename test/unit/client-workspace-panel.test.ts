// @vitest-environment happy-dom
import { createApp, nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it, vi } from 'vitest'
import WorkspaceFilePanel from '@/client/components/workspace-file-panel.vue'
import { api } from '@/client/lib/api'
import { useSyncStore } from '@/client/stores/sync'
import type { ConversationAsset } from '@/shared/conversation-assets'
import type { FileRecord } from '@/shared/workspace-files'

let cleanup = () => {}
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.innerHTML = '' })

function record(id: number, path: string): FileRecord {
  const relativePath = path.replace(/^\/(conversation|project)\//, '')
  return {
    id, path, relativePath, projectId: null, conversationId: 30, fileSize: 10, totalLines: 1,
    mime: 'text/plain; charset=utf-8', version: 1, updatedAt: 0, createdAt: 0,
    sourceConversationId: null, sourceMessageId: null,
  }
}

function asset(attachmentId: number, patch: Partial<ConversationAsset> = {}): ConversationAsset {
  return {
    attachmentId, ref: '3f9a2c1e', source: 'upload', mime: 'audio/mpeg', size: 1024,
    width: null, height: null, filename: 'song.mp3', createdAt: 0, ...patch,
  }
}

async function mountPanel() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const streaming = ref(false)
  vi.spyOn(useSyncStore(), 'isStreaming').mockImplementation(() => streaming.value)
  const host = document.createElement('div')
  document.body.append(host)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] })
  await router.push('/')
  const app = createApp(WorkspaceFilePanel, { mount: 'conversation', scopeId: 30 }).use(pinia).use(router)
  app.mount(host)
  cleanup = () => app.unmount()
  return { host, streaming }
}

const headings = (host: HTMLElement) => [...host.querySelectorAll('h3')].map(h => h.textContent)

it('lists the conversation, its assets and its Project in that order, assets read-only', async () => {
  vi.spyOn(api, 'conversationFiles').mockResolvedValue({
    files: [record(1, '/conversation/a.md')], projectFiles: [record(2, '/project/b.md')], projectId: 7,
  })
  vi.spyOn(api, 'conversationAssets').mockResolvedValue({ assets: [asset(38)] })
  const textPreview = vi.spyOn(api, 'workspaceFile')
  const { host } = await mountPanel()

  await vi.waitFor(() => expect(headings(host)).toEqual(['当前会话', '本会话的附件', '当前项目']))
  // Neither mount paths nor the model's references are shown to a person.
  expect(host.textContent).not.toContain('/conversation')
  expect(host.innerHTML).not.toMatch(/asset:|vfs:/)
  const row = host.querySelector<HTMLButtonElement>('[title="song.mp3"]')!
  expect(row).not.toBeNull()
  expect(host.querySelector('[aria-label="删除 song.mp3"]')).toBeNull()

  row.click()
  await nextTick()
  await vi.waitFor(() => expect(document.querySelector('audio')?.getAttribute('src')).toBe('/api/attachments/38'))
  expect(textPreview).not.toHaveBeenCalled()
})

it('hides the asset group when the conversation has none', async () => {
  vi.spyOn(api, 'conversationFiles').mockResolvedValue({ files: [record(1, '/conversation/a.md')], projectFiles: [], projectId: null })
  vi.spyOn(api, 'conversationAssets').mockResolvedValue({ assets: [] })
  const { host } = await mountPanel()
  await vi.waitFor(() => expect(host.textContent).toContain('a.md'))
  expect(headings(host)).toEqual(['当前会话'])
})

it('reloads when this conversation starts and stops streaming', async () => {
  const files = vi.spyOn(api, 'conversationFiles').mockResolvedValue({ files: [], projectFiles: [], projectId: null })
  const assets = vi.spyOn(api, 'conversationAssets').mockResolvedValue({ assets: [] })
  const { streaming } = await mountPanel()
  await vi.waitFor(() => expect(files).toHaveBeenCalledTimes(1))

  streaming.value = true
  await vi.waitFor(() => expect(files).toHaveBeenCalledTimes(2))
  // The generated image appears once the turn has finished.
  assets.mockResolvedValue({ assets: [asset(41, { source: 'generated', mime: 'image/png', filename: null, ref: '5c2e8f10' })] })
  streaming.value = false
  await vi.waitFor(() => expect(files).toHaveBeenCalledTimes(3))
  await vi.waitFor(() => expect(document.querySelector('[title^="图片"]')).not.toBeNull())
  expect(assets).toHaveBeenCalledTimes(3)
})

it('drops a slower earlier answer instead of showing it over a newer one', async () => {
  let resolveFirst!: (value: Awaited<ReturnType<typeof api.conversationFiles>>) => void
  vi.spyOn(api, 'conversationFiles')
    .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
    .mockResolvedValue({ files: [record(2, '/conversation/new.md')], projectFiles: [], projectId: null })
  vi.spyOn(api, 'conversationAssets').mockResolvedValue({ assets: [] })
  const { host, streaming } = await mountPanel()

  streaming.value = true
  await vi.waitFor(() => expect(host.textContent).toContain('new.md'))
  resolveFirst({ files: [record(1, '/conversation/old.md')], projectFiles: [], projectId: null })
  await nextTick()
  await nextTick()
  expect(host.textContent).not.toContain('old.md')
})
