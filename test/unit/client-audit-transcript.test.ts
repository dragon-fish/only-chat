// @vitest-environment happy-dom
import { createApp, defineComponent, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it } from 'vitest'
import MessageItem from '@/client/components/message-item.vue'
import { createAuditContext, provideAuditContext } from '@/client/lib/audit-context'
import type { Message } from '@/shared/models'

const user: Message = {
  id: 1, conversation_id: 1, parent_id: null, seq: 1, role: 'user',
  parts: [{ type: 'image', attachment_id: 7 }, { type: 'text', text: '看看这张图' }], provider_id: null, model_id: null,
  usage: null, status: 'done', error: null, created_at: 0,
}
const assistant: Message = { ...user, id: 2, parent_id: 1, seq: 2, role: 'assistant', parts: [{ type: 'text', text: '好的' }], provider_id: 1, model_id: 'm' }

let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })

function mount(audited: boolean) {
  const host = document.createElement('div')
  document.body.append(host)
  const Root = defineComponent(() => {
    if (audited) provideAuditContext(createAuditContext(() => []))
    return () => [user, assistant].map(message => h(MessageItem, { key: message.id, message, assistantName: '助手' }))
  })
  const app = createApp(Root).use(createPinia()).use(createRouter({
    history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }],
  }))
  app.mount(host)
  cleanup = () => app.unmount()
  return host
}

const controls = (host: HTMLElement) => ['编辑消息', '重新生成', '更多消息操作']
  .filter(label => host.querySelector(`[aria-label="${label}"]`) !== null)

it('offers the usual message controls outside an audit', () => {
  const host = mount(false)
  expect(controls(host)).toEqual(['编辑消息', '重新生成', '更多消息操作'])
  expect(host.querySelector('img')?.getAttribute('src')).toBe('/api/attachments/7')
})

it('renders an audited transcript without any control that writes, loading the audited account images', () => {
  const host = mount(true)
  expect(host.textContent).toContain('看看这张图')
  expect(host.textContent).toContain('好的')
  expect(controls(host)).toEqual([])
  expect(host.querySelector('img')?.getAttribute('src')).toBe('/api/admin/audit/attachments/7')
})
