// @vitest-environment happy-dom
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'vue-sonner'
import MessageItem from '@/client/components/message-item.vue'
import type { Message } from '@/shared/models'

const base: Message = {
  id: 1, conversation_id: 1, parent_id: null, seq: 0, role: 'assistant',
  parts: [], provider_id: 1, model_id: 'test', usage: null,
  status: 'done', error: null, created_at: 0,
}
let cleanup = () => {}
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.innerHTML = '' })
function mount(message: Partial<Message>) {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(MessageItem, { message: { ...base, ...message } })
    .use(createPinia()).use(createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    }))
  app.mount(host)
  cleanup = () => app.unmount()
  return host
}

it('copies final assistant markdown verbatim without reasoning or earlier progress', async () => {
  const host = mount({ parts: [
    { type: 'text', text: 'Let me check.' },
    { type: 'reasoning', text: 'Private reasoning' },
    { type: 'tool_call', id: 'call-1', name: 'example', args: {} },
    { type: 'tool_result', call_id: 'call-1', name: 'example', content: 'Tool output' },
    { type: 'text', text: '# Answer\n\n**bold**\n' },
    { type: 'text', text: '\n```ts\nconst n = 1\n```' },
  ] })
  const button = host.querySelector<HTMLButtonElement>('[aria-label="复制消息"]')!
  expect(button).not.toBeNull()
  expect(host.querySelector('[data-slot="message-footer"] button')).toBe(button)
  button.click()
  await vi.waitFor(async () => expect(await navigator.clipboard.readText()).toBe('# Answer\n\n**bold**\n\n```ts\nconst n = 1\n```'))
})

it('copies original user text without converting markdown or trimming whitespace', async () => {
  const host = mount({ role: 'user', parts: [
    { type: 'text', text: '  **original**\n' },
    { type: 'text', text: 'another paragraph  ' },
  ] })
  host.querySelector<HTMLButtonElement>('[aria-label="复制消息"]')!.click()
  await vi.waitFor(async () => expect(await navigator.clipboard.readText()).toBe('  **original**\n\nanother paragraph  '))
})

it.each([
  { status: 'streaming' as const, parts: [{ type: 'text' as const, text: 'unfinished' }] },
  { status: 'done' as const, parts: [{ type: 'reasoning' as const, text: 'No final answer' }] },
])('does not offer copying without a settled text reply: $status', (message) => {
  const host = mount(message)
  expect(host.querySelector('[aria-label="复制消息"]')).toBeNull()
})

it('reports clipboard failure without reporting success', async () => {
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
  const error = vi.spyOn(toast, 'error')
  const success = vi.spyOn(toast, 'success')
  const host = mount({ role: 'user', parts: [{ type: 'text', text: 'hello' }] })
  host.querySelector<HTMLButtonElement>('[aria-label="复制消息"]')!.click()
  await vi.waitFor(() => expect(error).toHaveBeenCalled())
  expect(success).not.toHaveBeenCalled()
})
