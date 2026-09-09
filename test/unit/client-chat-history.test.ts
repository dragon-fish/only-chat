// @vitest-environment happy-dom
import { createApp, h, nextTick, ref } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { Storage } from 'happy-dom'
import { afterEach, expect, it, vi } from 'vitest'
import ChatView from '@/client/views/chat.vue'
import { TooltipProvider } from '@/client/ui/tooltip'
import { useSyncStore } from '@/client/stores/sync'
import { useConfigStore } from '@/client/stores/config'
import { api } from '@/client/lib/api'
import type { ModelRef } from '@/shared/api'
import type { Message } from '@/shared/models'
import { modelRecords, provider } from './provider-fixtures'

let cleanup = () => {}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

async function mountChat(historyLoaded: boolean, rememberedModel = false, lastModel?: ModelRef) {
  const pinia = createPinia()
  const sync = useSyncStore(pinia)
  const config = useConfigStore(pinia)
  config.loaded = true
  if (rememberedModel || lastModel) config.providerRecords = [provider]
  if (lastModel) config.retainModels([{ ...modelRecords[0]!, provider_id: lastModel.provider_id, model_id: lastModel.model_id, metadata: { name: 'Conversation model' } }])
  sync.conversationsLoaded = true
  const histories = new Map<number, Message[]>()
  for (const id of [1, 2]) {
    const messages: Message[] = Array.from({ length: 10 }, (_, index) => ({
      id: id * 100 + index, conversation_id: id, parent_id: index ? id * 100 + index - 1 : null,
      seq: index, role: lastModel && id === 1 && index === 9 ? 'assistant' : 'user', parts: [{ type: 'text', text: `Chat ${id} message ${index}` }],
      provider_id: lastModel && id === 1 && index === 9 ? lastModel.provider_id : null,
      model_id: lastModel && id === 1 && index === 9 ? lastModel.model_id : null,
      usage: null, status: 'done', error: null, created_at: index,
    }))
    histories.set(id, messages)
    sync.conversations.set(id, { id, user_id: 1, project_id: null, title: `Chat ${id}`, head_message_id: id * 100 + 9, provider_id: null, model_id: null, system_prompt: null, params: null, tools: [], archived_at: null, created_at: 0, updated_at: id })
    sync.ingestMessages(id, messages)
    if (historyLoaded) sync.loadedMessageConversations.add(id)
  }
  vi.spyOn(api, 'messages').mockImplementation(id => historyLoaded ? Promise.resolve(histories.get(id)!) : new Promise(() => {}))
  const sid = ref(1)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push('/c/1')
  document.body.innerHTML = '<header id="page-header"></header><main id="test-host"></main>'
  const app = createApp({ render: () => h(TooltipProvider, null, () => h(ChatView, { conversationId: sid.value })) }).use(pinia).use(router)
  app.mount('#test-host')
  cleanup = () => app.unmount()
  await nextTick()
  return { sid }
}

it('retains a remembered model while its off-page lookup is pending', async () => {
  vi.stubGlobal('localStorage', new Storage())
  localStorage.setItem('oc.model', JSON.stringify({ provider_id: 1, model_id: 'off-page' }))
  let finish!: (model: typeof modelRecords[number]) => void
  vi.spyOn(api, 'modelByRef').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await mountChat(true, true)
  expect(document.querySelector('[aria-label="选择模型，当前为 off-page"]')).not.toBeNull()
  finish({ ...modelRecords[0]!, model_id: 'off-page', metadata: { name: 'Remembered model' } })
  await vi.waitFor(() => expect(document.querySelector('[aria-label="选择模型，当前为 Remembered model"]')).not.toBeNull())
})

it('restores an existing chat from the model used by its latest generation', async () => {
  vi.stubGlobal('localStorage', new Storage())
  localStorage.setItem('oc.model', JSON.stringify({ provider_id: 1, model_id: 'global-model' }))
  await mountChat(true, true, { provider_id: 1, model_id: 'conversation-model' })
  await vi.waitFor(() => expect(document.querySelector('[aria-label="选择模型，当前为 Conversation model"]')).not.toBeNull())
})

it('keeps arrived first-message content visible while its history request is pending', async () => {
  // The new-conversation route can mount after a WS message arrives but before its REST read completes.
  await mountChat(false)
  expect(document.querySelector('[role="log"]')?.textContent ?? '').toContain('Chat 1 message 0')
  expect(document.querySelector('[aria-label="正在加载"]')).toBeNull()
})

it('initializes the next cached history at its latest turn instead of carrying previous scroll state', async () => {
  // Happy DOM has no layout: these fixed, hand-derived dimensions model ten 100px messages in a
  // 200px viewport. The last user turn fits below the fold, so its initial scrollTop must be 800.
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.getAttribute('aria-label') === 'Messages' ? 200 : 0
  })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const viewport = document.querySelector<HTMLElement>('[aria-label="Messages"]')
    if (this === viewport) return new DOMRect(0, 0, 600, 200)
    if (this.getAttribute('role') === 'log') return new DOMRect(0, -(viewport?.scrollTop ?? 0), 600, 1000)
    if (this.hasAttribute('data-message-id')) {
      const index = [...this.parentElement!.children].indexOf(this)
      return new DOMRect(0, index * 100 - (viewport?.scrollTop ?? 0), 600, 100)
    }
    return new DOMRect()
  })
  const { sid } = await mountChat(true)
  const viewport = () => document.querySelector<HTMLElement>('[aria-label="Messages"]')!
  await vi.waitFor(() => expect(viewport().scrollTop).toBe(800))
  viewport().dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true }))
  viewport().scrollTop = 200
  viewport().dispatchEvent(new Event('scroll'))
  sid.value = 2
  await nextTick()
  await vi.waitFor(() => expect(document.querySelector('[role="log"]')?.textContent).toContain('Chat 2 message 0'))
  await vi.waitFor(() => expect(viewport().scrollTop).toBe(800))
})
