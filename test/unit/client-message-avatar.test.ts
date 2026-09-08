// @vitest-environment happy-dom
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { afterEach, expect, it } from 'vitest'
import MessageItem from '@/client/components/message-item.vue'
import type { Message, Project } from '@/shared/models'

const message: Message = {
  id: 1, session_id: 1, parent_id: null, seq: 0, role: 'assistant',
  parts: [{ type: 'text', text: 'Hello' }], provider_id: 1, model_id: 'deepseek-chat',
  usage: null, status: 'done', error: null, created_at: 0,
}
let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })

function mount(project?: Project, assistantModelFamily?: string, modelId = message.model_id!) {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(MessageItem, {
    message: { ...message, model_id: modelId },
    project,
    assistantName: 'DeepSeek Chat',
    assistantProviderName: 'DeepSeek',
    assistantLabId: 'deepseek',
    assistantModelFamily,
  }).use(createPinia())
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
  const project: Project = { id: 1, user_id: 1, name: 'Design Workspace', system_prompt: null, provider_id: null, model_id: null, params: null, created_at: 0, updated_at: 0 }
  const host = mount(project)
  expect(host.querySelector('[aria-label="Design Workspace"]')).not.toBeNull()
  expect(host.querySelector('[aria-label="deepseek"]')).toBeNull()
})
