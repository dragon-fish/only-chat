// @vitest-environment happy-dom
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it } from 'vitest'
import MessageItem from '@/client/components/message-item.vue'
import type { Message, Project } from '@/shared/models'

const message: Message = {
  id: 1, conversation_id: 1, parent_id: null, seq: 0, role: 'assistant',
  parts: [{ type: 'text', text: 'Hello' }], provider_id: 1, model_id: 'deepseek-chat',
  usage: null, status: 'done', error: null, created_at: 0,
}
let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })

function mount(project?: Project, assistantModelFamily?: string, modelId = message.model_id!, assistantProviderSuffix?: string) {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(MessageItem, {
    message: { ...message, model_id: modelId },
    project,
    assistantName: 'DeepSeek Chat',
    assistantProviderName: 'DeepSeek',
    assistantLabId: 'deepseek',
    assistantModelFamily,
    assistantProviderSuffix,
  }).use(createPinia()).use(createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  }))
  app.mount(host)
  cleanup = () => app.unmount()
  return host
}

it('uses the message model Lab avatar for non-Project assistant messages', () => {
  const host = mount()
  expect(host.querySelector('[aria-label="deepseek"] img')?.getAttribute('src')).toBe('https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/deepseek-color.svg')
})

it('prefers the message model family avatar when available', () => {
  const host = mount(undefined, 'claude-sonnet', 'anthropic/claude-sonnet-4-6')
  expect(host.querySelector('img')?.getAttribute('src')).toBe('https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/claude-color.svg')
})

it('keeps the workspace avatar for Project assistant messages', () => {
  const project: Project = { id: 1, user_id: 1, name: 'Design Workspace', icon_attachment_id: null, system_prompt: null, provider_id: null, model_id: null, params: null, created_at: 0, updated_at: 0 }
  const host = mount(project)
  expect(host.querySelector('[aria-label="Design Workspace"]')).not.toBeNull()
  expect(host.querySelector('[aria-label="deepseek"]')).toBeNull()
})

it('names the provider after the model, and leaves it out when the model no longer resolves', () => {
  const header = (host: HTMLElement) => host.querySelector('[data-slot="message-header"]')?.textContent?.replace(/\s+/g, '')
  expect(header(mount())).toBe('DeepSeekChat')
  cleanup(); document.body.innerHTML = ''
  expect(header(mount(undefined, undefined, message.model_id!, 'DeepSeek'))).toBe('DeepSeekChat(DeepSeek)')
})

it('marks an optimistic user bubble as pending and hides actions that require a real ID', () => {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(MessageItem, {
    message: {
      ...message,
      id: -1,
      role: 'user',
      provider_id: null,
      model_id: null,
      parts: [{ type: 'text', text: 'Sending now' }],
    },
    optimistic: true,
  }).use(createPinia())
  app.mount(host)
  cleanup = () => app.unmount()
  expect(host.querySelector('[data-optimistic]')).not.toBeNull()
  expect(host.querySelector('[aria-label="编辑消息"]')).toBeNull()
  expect(host.querySelector('[data-slot="message-footer"]')).toBeNull()
})
