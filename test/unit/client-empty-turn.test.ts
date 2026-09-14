// @vitest-environment happy-dom
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it } from 'vitest'
import MessageItem from '@/client/components/message-item.vue'
import type { Message } from '@/shared/models'

const base: Message = {
  id: 1, conversation_id: 1, parent_id: null, seq: 0, role: 'assistant',
  parts: [], provider_id: 1, model_id: 'deepseek-chat',
  usage: null, status: 'done', error: null, created_at: 0,
}

let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })

function mount(message: Message) {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(MessageItem, { message, assistantName: '助手' })
    .use(createPinia())
    .use(createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    }))
  app.mount(host)
  cleanup = () => app.unmount()
  return host
}

it('draws nothing for a settled turn that produced nothing', () => {
  // The hub asks the model again once a tool answers, and that turn can come back empty. Drawn
  // anyway it was an avatar and a name hanging beside nothing at all.
  expect(mount(base).textContent?.trim()).toBe('')
})

it('still draws a turn that failed, which has something to say', () => {
  const host = mount({ ...base, status: 'error', error: '上游炸了' })
  expect(host.textContent).toContain('上游炸了')
})

it('still draws a turn that said something', () => {
  const host = mount({ ...base, parts: [{ type: 'text', text: '你好' }] })
  expect(host.textContent).toContain('你好')
})

it('still draws a turn that is only now starting', () => {
  // An empty streaming shell is the placeholder the reader watches; hiding it would look like a
  // send that went nowhere.
  const host = mount({ ...base, status: 'streaming' })
  expect(host.textContent?.trim()).not.toBe('')
})
